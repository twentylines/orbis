#!/usr/bin/env python3
"""Create and verify the private host directory that holds reset intent.

The directory is the backing store of the dedicated reset authority mount. It
is created next to the installation data roots, never inside the legacy
``state/orbis-reset`` path, and it is only ever adopted when it already is an
empty private directory owned by the installer.
"""

import contextlib
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path


NAME = "orbis-reset"
TARGET = "/data/orbis-reset"
SCHEMA = "orbis.reset-authority.v1"
SCHEMA_V2 = "orbis.reset-authority.v2"
SCHEMA_V3 = "orbis.reset-authority.v3"
SCHEMA_V4 = "orbis.reset-authority.v4"
REVIEW_SCHEMA = "orbis.reset-authority.legacy-review.v1"
CONTROL_ROOT = Path("/var/lib/orbis/reset-authority")
MOUNTINFO_LIMIT = 4 * 1024 * 1024
EPHEMERAL_FILE_SYSTEMS = {
    "aufs",
    "cgroup",
    "cgroup2",
    "debugfs",
    "devtmpfs",
    "overlay",
    "nsfs",
    "proc",
    "ramfs",
    "securityfs",
    "sysfs",
    "tmpfs",
}


class ResetAuthorityError(ValueError):
    pass


def directory(root):
    return Path(root) / NAME


def external_directory(root, control_root=None):
    root = Path(root)
    if not root.is_absolute() or str(root) != os.path.realpath(root):
        raise ResetAuthorityError("The installation path must be canonical")
    base = Path(control_root) if control_root is not None else CONTROL_ROOT
    path = base / hashlib.sha256(os.fsencode(str(root))).hexdigest() / "data"
    if path.is_relative_to(root) or root.is_relative_to(path.parent):
        raise ResetAuthorityError("Reset authority must be outside installation storage")
    return path


def binding_path(root, binding):
    if not isinstance(binding, dict):
        raise ResetAuthorityError("The reset storage binding is invalid")
    if binding.get("schema") == SCHEMA:
        return directory(root)
    if binding.get("schema") in {SCHEMA_V2, SCHEMA_V3, SCHEMA_V4}:
        expected = external_directory(root)
        if binding.get("path") != str(expected):
            raise ResetAuthorityError("The reset storage path differs from its namespace")
        return expected
    raise ResetAuthorityError("The reset storage binding version is unsupported")


def compose_mount(root, readonly=False, binding=None):
    return {
        "type": "bind",
        "source": str(binding_path(root, binding) if binding is not None else directory(root)),
        "target": TARGET,
        "read_only": readonly,
        "bind": {"create_host_path": False},
    }


def _unescape(value):
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match.group(1), 8)), value)


def _mount_entries(mountinfo):
    try:
        with Path(mountinfo).open("rb") as source:
            data = source.read(MOUNTINFO_LIMIT + 1)
    except OSError as error:
        raise ResetAuthorityError("Host mount information for reset storage is unavailable") from error
    if not data or len(data) > MOUNTINFO_LIMIT:
        raise ResetAuthorityError("Host mount information for reset storage is unavailable")
    try:
        lines = data.decode("utf-8").splitlines()
    except UnicodeError as error:
        raise ResetAuthorityError("Host mount information for reset storage is unavailable") from error
    entries = []
    for line in lines:
        fields = line.split(" ")
        separator = next((index for index in range(6, len(fields)) if fields[index] == "-"), -1)
        if (
            len(fields) < 10
            or not fields[0].isdigit()
            or not fields[1].isdigit()
            or re.fullmatch(r"[0-9]+:[0-9]+", fields[2]) is None
            or not (fields[3].startswith("/") or (separator >= 0 and separator + 1 < len(fields)
                    and fields[separator + 1] == "nsfs"
                    and re.fullmatch(r"(?:net|mnt|pid|ipc|uts|user|cgroup|time):\[[0-9]+\]", fields[3])))
            or not fields[4].startswith("/")
            or separator == -1
            or separator + 3 >= len(fields)
            or any(not field for field in fields)
        ):
            raise ResetAuthorityError("Host mount information for reset storage is unavailable")
        entries.append({"path": _unescape(fields[4]), "fsType": _unescape(fields[separator + 1]), "identity": line})
    if not entries:
        raise ResetAuthorityError("Host mount information for reset storage is unavailable")
    return entries


def filesystem(path, mountinfo=None):
    path = Path(path)
    if mountinfo is None:
        mountinfo = Path("/proc/self/mountinfo")
    entries = _mount_entries(mountinfo)
    covering = [entry for entry in entries if path == Path(entry["path"]) or path.is_relative_to(entry["path"])]
    if len({entry["path"] for entry in covering}) != len(covering):
        raise ResetAuthorityError("Reset storage has stacked mounts; review the host before installing")
    if not covering:
        raise ResetAuthorityError("The reset storage backing filesystem could not be identified")
    selected = max(covering, key=lambda entry: len(entry["path"]))
    if selected["fsType"] in EPHEMERAL_FILE_SYSTEMS:
        raise ResetAuthorityError("Reset storage must be persistent; its backing filesystem is temporary")
    return selected


@contextlib.contextmanager
def _root_descriptor(root):
    root = Path(root)
    if not root.is_absolute() or str(root) != os.path.realpath(root):
        raise ResetAuthorityError("The installation path must be a canonical absolute directory")
    descriptors = []
    identities = []
    try:
        descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(descriptor)
        for name in root.parts[1:]:
            details = os.fstat(descriptor)
            if details.st_uid not in {0, os.geteuid()} or stat.S_IMODE(details.st_mode) & 0o022:
                raise ResetAuthorityError("Reset storage ancestors must be owned and not writable by other users")
            descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            descriptors.append(descriptor)
            identities.append((name, os.fstat(descriptor)))
        details = os.fstat(descriptor)
        if details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) & 0o022:
            raise ResetAuthorityError("The installation root must be owned by the installer and not writable by other users")
        yield descriptor
        # Every operation uses pinned descriptors; reject a renamed/replaced ancestor before returning.
        for parent, (name, before) in zip(descriptors, identities):
            after = os.stat(name, dir_fd=parent, follow_symlinks=False)
            current = os.fstat(parent)
            if (after.st_dev, after.st_ino, after.st_mode, after.st_uid) != (before.st_dev, before.st_ino, before.st_mode, before.st_uid):
                raise ResetAuthorityError("Reset storage ancestors changed during review")
            if current.st_uid not in {0, os.geteuid()} or stat.S_IMODE(current.st_mode) & 0o022:
                raise ResetAuthorityError("Reset storage ancestor permissions changed during review")
    except OSError as error:
        raise ResetAuthorityError("Reset storage could not be opened safely") from error
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def _require_private(details):
    if stat.S_ISLNK(details.st_mode) or not stat.S_ISDIR(details.st_mode):
        raise ResetAuthorityError("Reset storage must be a directory, not a symlink or file")
    if details.st_uid != os.geteuid():
        raise ResetAuthorityError("Reset storage is owned by another user")
    if stat.S_IMODE(details.st_mode) != 0o700:
        raise ResetAuthorityError("Reset storage must be private to the installer")


def _open_authority(root_descriptor):
    return os.open(NAME, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_descriptor)


def _binding(root, opened):
    path = directory(root)
    if os.path.realpath(path) != os.fspath(path):
        raise ResetAuthorityError("Reset storage must be a canonical directory")
    return {
        "schema": SCHEMA,
        "path": str(path),
        "device": int(opened.st_dev),
        "inode": int(opened.st_ino),
        "mode": stat.S_IMODE(opened.st_mode),
        "uid": int(opened.st_uid),
    }


def _backing(root, mountinfo):
    backing = filesystem(directory(root), mountinfo)
    if backing != filesystem(root, mountinfo):
        raise ResetAuthorityError("Reset backing must be a private sibling directory, not an aliased host mount")
    return backing


def prepare(root, mountinfo=None):
    """Create or adopt the empty private directory and report its identity."""
    root = Path(root)
    with _root_descriptor(root) as descriptor:
        backing = _backing(root, mountinfo)
        created = False
        try:
            authority = _open_authority(descriptor)
        except FileNotFoundError:
            try:
                os.mkdir(NAME, 0o700, dir_fd=descriptor)
                os.fsync(descriptor)
            except OSError as error:
                raise ResetAuthorityError("Reset storage could not be created") from error
            created = True
            try:
                authority = _open_authority(descriptor)
            except OSError as error:
                raise ResetAuthorityError("Reset storage was created but cannot be opened safely") from error
        except OSError as error:
            raise ResetAuthorityError("Reset storage must be a private directory, not a symlink or file") from error
        try:
            opened = os.fstat(authority)
            entry = os.stat(NAME, dir_fd=descriptor, follow_symlinks=False)
            if (opened.st_dev, opened.st_ino) != (entry.st_dev, entry.st_ino):
                raise ResetAuthorityError("Reset storage changed while it was prepared")
            if created:
                os.fchmod(authority, 0o700)
                opened = os.fstat(authority)
            _require_private(opened)
            if os.listdir(authority):
                raise ResetAuthorityError("Existing reset storage holds data; preserve it for local review")
            binding = _binding(root, opened)
            os.fsync(authority)
            binding["filesystem"] = backing
            if _backing(root, mountinfo) != backing:
                raise ResetAuthorityError("Reset backing mount changed during preparation")
            _assert_entry(descriptor, authority)
            return binding
        finally:
            os.close(authority)


def verify(root, binding, mountinfo=None, *, daemon=None, context=None):
    if isinstance(binding, dict) and binding.get("schema") in {SCHEMA_V2, SCHEMA_V3, SCHEMA_V4}:
        return verify_external(root, binding, daemon, context, mountinfo)
    """Re-check the recorded directory identity without creating or changing anything."""
    root = Path(root)
    path = directory(root)
    if (
        not isinstance(binding, dict)
        or binding.get("schema") != SCHEMA
        or binding.get("path") != str(path)
        or type(binding.get("device")) is not int
        or type(binding.get("inode")) is not int
        or type(binding.get("mode")) is not int
        or type(binding.get("uid")) is not int
        or not isinstance(binding.get("filesystem"), dict)
    ):
        raise ResetAuthorityError("The reset storage binding of this installation is invalid")
    with _root_descriptor(root) as descriptor:
        try:
            authority = _open_authority(descriptor)
        except OSError as error:
            raise ResetAuthorityError("Reset storage is missing or is not a private directory") from error
        try:
            opened = os.fstat(authority)
            entry = os.stat(NAME, dir_fd=descriptor, follow_symlinks=False)
            if (opened.st_dev, opened.st_ino) != (entry.st_dev, entry.st_ino):
                raise ResetAuthorityError("Reset storage changed during startup review")
            _require_private(opened)
            current = _binding(root, opened)
            if any(current[key] != binding[key] for key in ("path", "device", "inode", "mode", "uid")):
                raise ResetAuthorityError("Reset storage changed after this installation was prepared")
            if _backing(root, mountinfo) != binding["filesystem"]:
                raise ResetAuthorityError("The reset storage backing filesystem changed")
            _assert_entry(descriptor, authority)
            return binding
        finally:
            os.close(authority)


def _assert_entry(parent, authority):
    opened = os.fstat(authority)
    entry = os.stat(NAME, dir_fd=parent, follow_symlinks=False)
    _require_private(opened)
    if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_uid) != (entry.st_dev, entry.st_ino, entry.st_mode, entry.st_uid):
        raise ResetAuthorityError("Reset storage changed during review")



@contextlib.contextmanager
def _control_descriptor(path, create=False):
    path = Path(path)
    if not path.is_absolute() or str(path) != os.path.realpath(path):
        raise ResetAuthorityError("Reset control path must be canonical")
    descriptors, identities = [], []
    try:
        current = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(current)
        for name in path.parts[1:]:
            details = os.fstat(current)
            if details.st_uid not in {0, os.geteuid()} or stat.S_IMODE(details.st_mode) & 0o022:
                raise ResetAuthorityError("Reset control ancestors must be owned and not writable by others")
            try:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(name, 0o700, dir_fd=current)
                os.fsync(current)
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            identities.append((name, os.fstat(child)))
            current = child
            descriptors.append(current)
        details = os.fstat(current)
        if details.st_uid not in {0, os.geteuid()} or stat.S_IMODE(details.st_mode) & 0o022:
            raise ResetAuthorityError("Reset control directory is not protected")
        yield current
        for parent, (name, before) in zip(descriptors, identities):
            after = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if (after.st_dev, after.st_ino, after.st_mode, after.st_uid) != (before.st_dev, before.st_ino, before.st_mode, before.st_uid):
                raise ResetAuthorityError("Reset control path changed during review")
            details = os.fstat(parent)
            if details.st_uid not in {0, os.geteuid()} or stat.S_IMODE(details.st_mode) & 0o022:
                raise ResetAuthorityError("Reset control permissions changed during review")
    except OSError as error:
        raise ResetAuthorityError("Reset control path could not be opened safely") from error
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def _installation_identity(root):
    with _root_descriptor(root) as descriptor:
        info = os.fstat(descriptor)
        return {"path": str(root), "device": info.st_dev, "inode": info.st_ino}


def _external_identity(root, daemon, context):
    if not isinstance(daemon, str) or not daemon or not isinstance(context, str) or not context:
        raise ResetAuthorityError("Docker identity is required for reset enrollment")
    return {"installation": _installation_identity(root), "daemon": daemon, "context": context}


@contextlib.contextmanager
def _reviewed_ancestry(root):
    root = Path(root)
    if not root.is_absolute() or str(root) != os.path.realpath(root):
        raise ResetAuthorityError("The installation path must be canonical")
    descriptors, names, identities = [], [], []
    def identity(fd):
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o002:
            raise ResetAuthorityError("Reviewed installation ancestry must not be world-writable")
        return {"device": info.st_dev, "inode": info.st_ino, "uid": info.st_uid,
                "gid": info.st_gid, "mode": stat.S_IMODE(info.st_mode)}
    def seal():
        for index, fd in enumerate(descriptors):
            if identity(fd) != identities[index]:
                raise ResetAuthorityError("Reviewed installation ancestry changed")
            if index:
                info = os.stat(names[index - 1], dir_fd=descriptors[index - 1], follow_symlinks=False)
                expected = identities[index]
                if (not stat.S_ISDIR(info.st_mode) or
                    (info.st_dev, info.st_ino, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) !=
                    (expected["device"], expected["inode"], expected["uid"], expected["gid"], expected["mode"])):
                    raise ResetAuthorityError("Reviewed installation ancestry changed")
    try:
        descriptors.append(os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
        identities.append(identity(descriptors[-1]))
        for name in root.parts[1:]:
            descriptors.append(os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptors[-1]))
            names.append(name)
            identities.append(identity(descriptors[-1]))
        yield identities, seal
        seal()
    except OSError as error:
        raise ResetAuthorityError("Reviewed installation ancestry could not be opened safely") from error
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def _review_plan(root, daemon, context, ancestry, mountinfo):
    if not isinstance(daemon, str) or not daemon or not isinstance(context, str) or not context:
        raise ResetAuthorityError("Docker identity is required for reset enrollment")
    path = external_directory(root)
    backing = filesystem(path, mountinfo)
    if backing != filesystem(path.parent.parent, mountinfo):
        raise ResetAuthorityError("Reset storage cannot use an aliased mount")
    return {"schema": REVIEW_SCHEMA, "root": str(root), "ancestry": ancestry,
            "daemon": daemon, "context": context, "path": str(path),
            "filesystem": _durable_filesystem(backing)}


def review_plan_sha256(plan):
    return hashlib.sha256(json.dumps(plan, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def review_external_legacy(root, daemon, context, mountinfo=None):
    """Produce a read-only plan for a root operator to review and approve."""
    root = Path(root)
    with _reviewed_ancestry(root) as (ancestry, seal):
        plan = _review_plan(root, daemon, context, ancestry, mountinfo)
        seal()
        return plan


def prepare_external_reviewed(root, daemon, context, approved_plan_sha256, mountinfo=None):
    root = Path(root)
    with _reviewed_ancestry(root) as (ancestry, seal):
        plan = _review_plan(root, daemon, context, ancestry, mountinfo)
        if not isinstance(approved_plan_sha256, str) or approved_plan_sha256 != review_plan_sha256(plan):
            raise ResetAuthorityError("An exact root-operator review plan approval is required")
        def check():
            seal()
            if _review_plan(root, daemon, context, ancestry, mountinfo) != plan:
                raise ResetAuthorityError("Reviewed reset enrollment plan changed")
        identity = {"installation": {"path": str(root), "device": ancestry[-1]["device"],
                                     "inode": ancestry[-1]["inode"]},
                    "daemon": daemon, "context": context, "reviewed_plan": plan,
                    "approved_plan_sha256": approved_plan_sha256}
        check()
        return _prepare_external(root, daemon, context, mountinfo, SCHEMA_V4, identity, check)


def prepare_external(root, daemon, context, mountinfo=None):
    return _prepare_external(root, daemon, context, mountinfo, SCHEMA_V2)


def prepare_external_durable(root, daemon, context, mountinfo=None):
    return _prepare_external(root, daemon, context, mountinfo, SCHEMA_V3)


def _durable_filesystem(view):
    if not isinstance(view, dict) or not isinstance(view.get("identity"), str):
        raise ResetAuthorityError("Reset backing filesystem identity is invalid")
    fields = view["identity"].split(" ")
    separator = fields.index("-", 6)
    if separator + 3 >= len(fields):
        raise ResetAuthorityError("Reset backing filesystem identity is invalid")
    # Kernel mount and propagation group IDs identify this namespace observation,
    # not the persisted data. Keep propagation kinds and all filesystem/permission
    # fields; callers separately seal the complete observation within each operation.
    propagation = set()
    for field in fields[6:separator]:
        kind, colon, group = field.partition(":")
        if field == "unbindable":
            propagation.add(field)
        elif kind in {"shared", "master", "propagate_from"} and colon and group.isdigit():
            propagation.add(kind)
        else:
            raise ResetAuthorityError("Reset backing propagation information is unsupported")
    return {"path": view["path"], "fsType": view["fsType"], "device": fields[2],
            "root": _unescape(fields[3]), "source": _unescape(fields[separator + 2]),
            "options": sorted(fields[5].split(",")), "superOptions": sorted(fields[separator + 3].split(",")),
            "propagation": sorted(propagation)}


def _prepare_external(root, daemon, context, mountinfo, schema, identity=None, check=None):
    root = Path(root)
    if identity is None:
        identity = _external_identity(root, daemon, context)
    path = external_directory(root)
    with _control_descriptor(path.parent.parent, create=True) as base:
        if schema == SCHEMA_V4:
            _require_private(os.fstat(base))
            check()
        if filesystem(path.parent.parent, mountinfo) != filesystem(path, mountinfo):
            raise ResetAuthorityError("Reset storage cannot use an aliased mount")
        try:
            os.mkdir(path.parent.name, 0o700, dir_fd=base)
        except FileExistsError as error:
            raise ResetAuthorityError("Reset enrollment already exists or was interrupted; preserve it for review") from error
        os.fsync(base)
        namespace = os.open(path.parent.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=base)
        try:
            _require_private(os.fstat(namespace))
            os.mkdir("data", 0o700, dir_fd=namespace)
            os.fsync(namespace)
            data = os.open("data", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=namespace)
            try:
                details = os.fstat(data)
                _require_private(details)
                backing = filesystem(path, mountinfo)
                if backing != filesystem(path.parent.parent, mountinfo):
                    raise ResetAuthorityError("Reset storage cannot use an aliased mount")
                binding = {"schema": schema, "path": str(path), "device": details.st_dev,
                           "inode": details.st_ino, "mode": stat.S_IMODE(details.st_mode),
                           "uid": details.st_uid, "filesystem": backing, **identity}
                body = (json.dumps(binding, sort_keys=True, separators=(",", ":")) + "\n").encode()
                receipt = os.open("enrollment.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=namespace)
                with os.fdopen(receipt, "wb") as output:
                    os.fchmod(output.fileno(), 0o600)
                    output.write(body)
                    output.flush()
                    os.fsync(output.fileno())
                os.fsync(namespace)
                os.fsync(data)
                _assert_entry_named(namespace, data, "data")
                _assert_entry_named(base, namespace, path.parent.name)
                if check is not None:
                    check()
                elif _external_identity(root, daemon, context) != identity:
                    raise ResetAuthorityError("Reset enrollment changed during preparation")
                if filesystem(path, mountinfo) != backing:
                    raise ResetAuthorityError("Reset enrollment changed during preparation")
                verify_external(root, binding, daemon, context, mountinfo)
                return binding
            finally:
                os.close(data)
        finally:
            os.close(namespace)


def _assert_entry_named(parent, descriptor, name):
    opened = os.fstat(descriptor)
    entry = os.stat(name, dir_fd=parent, follow_symlinks=False)
    _require_private(opened)
    if (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_uid) != (entry.st_dev, entry.st_ino, entry.st_mode, entry.st_uid):
        raise ResetAuthorityError("Reset storage changed during review")


def verify_external(root, binding, daemon, context, mountinfo=None):
    root = Path(root)
    path = binding_path(root, binding)
    if binding.get("schema") == SCHEMA_V4:
        return verify_external_v4(root, binding, daemon, context, mountinfo)
    if _external_identity(root, daemon, context) != {key: binding.get(key) for key in ("installation", "daemon", "context")}:
        raise ResetAuthorityError("Reset enrollment belongs to a different installation or Docker daemon")
    return _verify_external_opened(root, binding, daemon, context, mountinfo)


def verify_external_v4(root, binding, daemon, context, mountinfo=None):
    root = Path(root)
    with _reviewed_ancestry(root) as (ancestry, seal):
        plan = _review_plan(root, daemon, context, ancestry, mountinfo)
        installation = {"path": str(root), "device": ancestry[-1]["device"], "inode": ancestry[-1]["inode"]}
        if (binding.get("schema") != SCHEMA_V4 or binding.get("reviewed_plan") != plan
                or binding.get("approved_plan_sha256") != review_plan_sha256(plan)
                or binding.get("installation") != installation or binding.get("daemon") != daemon
                or binding.get("context") != context):
            raise ResetAuthorityError("Reviewed reset enrollment identity changed")
        with _control_descriptor(external_directory(root).parent.parent) as base:
            _require_private(os.fstat(base))
            result = _verify_external_opened(root, binding, daemon, context, mountinfo, seal)
        seal()
        if _review_plan(root, daemon, context, ancestry, mountinfo) != plan:
            raise ResetAuthorityError("Reviewed reset enrollment plan changed")
        return result


def _verify_external_opened(root, binding, daemon, context, mountinfo, reviewed_seal=None):
    path = binding_path(root, binding)
    with _control_descriptor(path.parent) as namespace:
        _require_private(os.fstat(namespace))
        try:
            receipt = os.open("enrollment.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=namespace)
            try:
                info = os.fstat(receipt)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
                    raise ResetAuthorityError("Reset enrollment receipt is not protected")
                with os.fdopen(receipt, "rb", closefd=False) as source:
                    body = source.read(16385)
                if len(body) > 16384 or json.loads(body) != binding:
                    raise ResetAuthorityError("Reset enrollment receipt changed")
                after = os.stat("enrollment.json", dir_fd=namespace, follow_symlinks=False)
                if (info.st_dev, info.st_ino, info.st_mode, info.st_uid) != (after.st_dev, after.st_ino, after.st_mode, after.st_uid):
                    raise ResetAuthorityError("Reset enrollment receipt changed")
            finally:
                os.close(receipt)
            data = os.open("data", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=namespace)
            try:
                info = os.fstat(data)
                _assert_entry_named(namespace, data, "data")
                if any(binding.get(key) != value for key, value in (("device", info.st_dev), ("inode", info.st_ino), ("mode", stat.S_IMODE(info.st_mode)), ("uid", info.st_uid))):
                    raise ResetAuthorityError("Reset storage changed after enrollment")
                before = filesystem(path, mountinfo)
                parent_before = filesystem(path.parent, mountinfo)
                if binding.get("schema") in {SCHEMA_V3, SCHEMA_V4}:
                    same_backing = (_durable_filesystem(before) == _durable_filesystem(binding.get("filesystem"))
                                    and _durable_filesystem(parent_before) == _durable_filesystem(binding.get("filesystem")))
                else:
                    same_backing = before == binding.get("filesystem") and parent_before == binding.get("filesystem")
                if not same_backing:
                    raise ResetAuthorityError("Reset storage backing filesystem changed")
                if reviewed_seal is not None:
                    reviewed_seal()
                elif _external_identity(root, daemon, context) != {key: binding.get(key) for key in ("installation", "daemon", "context")}:
                    raise ResetAuthorityError("Reset installation changed during review")
                if filesystem(path, mountinfo) != before or filesystem(path.parent, mountinfo) != parent_before:
                    raise ResetAuthorityError("Reset backing mount changed during review")
                return binding
            finally:
                os.close(data)
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise ResetAuthorityError("Reset enrollment is missing or invalid; preserve it for review") from error


def require_compose(root, config, binding):
    mounts = config.get("services", {}).get("runtipi", {}).get("volumes", [])
    if any((isinstance(item, dict) and str(item.get("target", "")).startswith(TARGET + "/"))
           or (isinstance(item, str) and any(part.startswith(TARGET + "/") for part in item.split(":"))) for item in mounts):
        raise ResetAuthorityError("Nested reset authority mounts are not permitted")
    # New transactions use structured mounts. Legacy transactions must never gain a mount implicitly.
    matches = [item for item in mounts if (isinstance(item, dict) and item.get("target") == TARGET)
               or (isinstance(item, str) and TARGET in item.split(":"))]
    if binding is None:
        if matches:
            raise ResetAuthorityError("Reset mount has no recorded backing identity; preserve the transaction")
        return False
    if matches != [compose_mount(root, binding=binding)]:
        raise ResetAuthorityError("Reset mount differs from the recorded private backing")
    return True


def read_external_enrollment(root, daemon, context):
    """Read protected enrollment and verify its current installation binding."""
    path = external_directory(root)
    with _control_descriptor(path.parent) as namespace:
        _require_private(os.fstat(namespace))
        try:
            receipt = os.open("enrollment.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=namespace)
            try:
                info = os.fstat(receipt)
                if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid()
                        or stat.S_IMODE(info.st_mode) != 0o600):
                    raise ResetAuthorityError("Reset enrollment receipt is not protected")
                with os.fdopen(receipt, "rb", closefd=False) as source:
                    body = source.read(16385)
                if len(body) > 16384:
                    raise ResetAuthorityError("Reset enrollment receipt is too large")
                binding = json.loads(body)
            finally:
                os.close(receipt)
        except (OSError, ValueError, TypeError) as error:
            raise ResetAuthorityError("Reset enrollment is unavailable; preserve it for review") from error
    if not isinstance(binding, dict) or binding.get("schema") not in {SCHEMA_V2, SCHEMA_V3, SCHEMA_V4}:
        raise ResetAuthorityError("Reset enrollment version is unsupported")
    return verify_external(root, binding, daemon, context)


def require_runtime(root, mounts, binding=None):
    if not isinstance(mounts, list) or any(not isinstance(item, dict) for item in mounts):
        raise ResetAuthorityError("Running reset mount information is invalid")
    if any(str(item.get("Destination", "")).startswith(TARGET + "/") for item in mounts):
        raise ResetAuthorityError("Nested running reset authority mounts are not permitted")
    matches = [item for item in mounts if item.get("Destination") == TARGET]
    if (len(matches) != 1 or matches[0].get("Type") != "bind"
            or matches[0].get("Source") != str(binding_path(root, binding) if binding is not None else directory(root)) or matches[0].get("RW") is not True
            or matches[0].get("Propagation") != "rprivate"):
        raise ResetAuthorityError("Running controller does not use the recorded private reset backing")
    require_no_enrollment_aliases(root, mounts, binding, allowed=matches[0])


def require_no_enrollment_aliases(root, mounts, binding=None, *, allowed=None):
    """Reject other writable paths into the data or its protected enrollment."""
    if not isinstance(mounts, list) or any(not isinstance(item, dict) for item in mounts):
        raise ResetAuthorityError("Reset storage writer information is invalid")
    backing = binding_path(root, binding) if binding is not None else directory(root)
    protected = backing.parent if binding is not None and binding.get("schema") in {SCHEMA_V2, SCHEMA_V3, SCHEMA_V4} else backing
    protected = protected.resolve(strict=False)
    for item in mounts:
        if item is allowed or item.get("Type") == "tmpfs":
            continue
        if type(item.get("RW")) is not bool:
            raise ResetAuthorityError("Reset storage writer permissions are invalid")
        if not item["RW"]:
            continue
        source = item.get("Source")
        if not isinstance(source, str) or not Path(source).is_absolute():
            raise ResetAuthorityError("Reset storage writer source is invalid")
        source = Path(source).resolve(strict=False)
        if source == protected or source.is_relative_to(protected) or protected.is_relative_to(source):
            raise ResetAuthorityError("Another writable mount exposes protected reset storage")


def require_docker_isolation(root, reader, binding, controller_id=None):
    """Review all containers, including stopped ones that could restart later.

    Container mount definitions cannot change in place. Repeating the inventory
    detects creation/removal during the review; this is not a lock against an
    independent host administrator changing Docker after the review.
    """
    def identifiers():
        rows = reader.containers()
        if not isinstance(rows, list) or len(rows) > 4096:
            raise ResetAuthorityError("Reset storage container inventory is invalid")
        values = [item.get("id") if isinstance(item, dict) else None for item in rows]
        if (any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value) for value in values)
                or len(set(values)) != len(values)):
            raise ResetAuthorityError("Reset storage container identities are invalid")
        return set(values)

    daemon = reader.daemon()
    before = identifiers()
    if controller_id is not None and controller_id not in before:
        raise ResetAuthorityError("The reset storage controller is missing")
    for identifier in sorted(before):
        current = reader.core(identifier)
        if not isinstance(current, dict) or current.get("id") != identifier:
            raise ResetAuthorityError("Reset storage container identity changed")
        if identifier == controller_id:
            require_runtime(root, current.get("mounts"), binding)
        else:
            require_no_enrollment_aliases(root, current.get("mounts"), binding)
    if identifiers() != before or reader.daemon() != daemon:
        raise ResetAuthorityError("Reset storage container inventory changed during review")


if __name__ == "__main__":
    print("This helper is imported by the Orbis installer.")
    sys.exit(2)
