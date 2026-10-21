#!/usr/bin/env python3
"""Reset controller accounts while retaining installed apps and server storage.

Called only by the stopped-writer replacement transaction, after its verified
backup and unpublished hold check. No signing key or cached credential is
written to the replacement journal.
"""

import hashlib
import json
import os
import re
import secrets
import shlex
import shutil
import sqlite3
import stat
import subprocess
import tempfile
from contextlib import closing
from pathlib import Path


class FreshError(ValueError):
    pass


def key_hash(key):
    return hashlib.sha256(key.encode()).hexdigest()


ACCOUNT_QUERY = '''
SELECT jsonb_build_object(
 'users', (SELECT count(*) FROM public."user"),
 'links', (SELECT count(*) FROM public.link),
 'references', (SELECT coalesce(jsonb_agg(conrelid::regclass::text ORDER BY conname), '[]'::jsonb)
   FROM pg_constraint WHERE contype = 'f' AND confrelid = 'public."user"'::regclass),
 'customTriggers', (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal
   AND tgrelid IN ('public."user"'::regclass, 'public.link'::regclass)),
 'descendants', (SELECT count(*) FROM pg_inherits WHERE inhparent
   IN ('public."user"'::regclass, 'public.link'::regclass)),
 'apps', (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(a) ORDER BY id), '[]'::jsonb)::text, 'UTF8')), 'hex') FROM public.app a),
 'stores', (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(s) ORDER BY slug), '[]'::jsonb)::text, 'UTF8')), 'hex') FROM public.app_store s)
)
'''
RESET_QUERY = '''
SET statement_timeout = '30s';
SET lock_timeout = '5s';
BEGIN;
LOCK TABLE public.app, public.app_store IN SHARE MODE;
TRUNCATE TABLE ONLY public.link, ONLY public."user" RESTART IDENTITY RESTRICT;
COMMIT;
'''


def accounts(reader, database):
    value = json.loads(reader._read(["exec", database, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "tipi", "-d", "tipi", "-Atqc", ACCOUNT_QUERY]))
    if not isinstance(value, dict) or any(type(value.get(key)) is not int or value[key] < 0 for key in ("users", "links")):
        raise FreshError("Account storage could not be reviewed")
    if value.get("references") != ["link"] or value.get("customTriggers") != 0 or value.get("descendants") != 0:
        raise FreshError("Custom account tables or triggers need a separate Fresh migration review")
    if any(not re.fullmatch(r"[0-9a-f]{64}", str(value.get(key, ""))) for key in ("apps", "stores")):
        raise FreshError("Installed app metadata could not be verified")
    return value


def regular(file, *, optional=False):
    try:
        info = file.lstat()
    except FileNotFoundError:
        if optional:
            return None
        raise FreshError("A required controller state file is missing") from None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise FreshError("Controller state files must be regular files without additional hard links")
    return info


def environment(root):
    file = root / ".env"
    info = regular(file)
    if info.st_size > 1024 * 1024:
        raise FreshError("The controller environment file exceeds its limit")
    text = file.read_bytes().decode("utf-8")
    matches = list(re.finditer(r"(?m)^[ \t]*(?:export[ \t]+)?JWT_SECRET[ \t]*=[^\r\n]*", text))
    if len(matches) != 1:
        raise FreshError("Fresh migration requires one JWT_SECRET assignment in the controller environment")
    assignment = matches[0].group()
    try:
        parsed = shlex.split(assignment.partition("=")[2], comments=True)
    except ValueError:
        raise FreshError("The controller signing key requires a separate environment review") from None
    if len(parsed) != 1 or not parsed[0] or len(parsed[0]) > 4096:
        raise FreshError("The controller signing key is missing or unsupported")
    return text, parsed[0], matches[0], info


def secret(root):
    return environment(root)[1]


def compose_intent(root, reader):
    command = ["docker", "--context", reader.context, "compose", "--project-name", "runtipi", "-f", str(root / "docker-compose.yml")]
    for file in (root / "user-config/tipi-compose.yml", root / "orbis-compose.yml"):
        if file.is_file():
            command += ["-f", str(file)]
    result = subprocess.run(command + ["config", "--no-interpolate", "--no-env-resolution", "--format", "json"],
                            cwd=root, capture_output=True, text=True, timeout=30, check=False)
    if result.returncode or len(result.stdout) > 8 * 1024 * 1024:
        raise FreshError("Docker Compose could not review the signing-key source")
    core = json.loads(result.stdout).get("services", {}).get("runtipi", {})
    override = core.get("environment", {}).get("JWT_SECRET")
    if override is not None:
        if override not in ("${JWT_SECRET}", "$JWT_SECRET"):
            raise FreshError("A custom signing-key override prevents Fresh migration")
    else:
        files = core.get("env_file", [])
        paths = [item.get("path") if isinstance(item, dict) else item for item in files]
        if paths != [str(root / ".env")]:
            raise FreshError("The controller must load its signing key from the reviewed environment file")


def directory(path):
    if path.is_symlink() or not path.is_dir() or path.resolve(strict=True) != path:
        raise FreshError("Fresh migration needs canonical controller state directories")
    info = path.stat()
    return {"device": info.st_dev, "inode": info.st_ino}


def preference_directories(state):
    for name in ("desktop", "onboarding"):
        target = state / name
        if not target.exists() and not target.is_symlink():
            continue
        directory(target)
        count = 0
        for base, directories, files in os.walk(target):
            for name in directories:
                directory(Path(base) / name)
                count += 1
                if count > 10000:
                    raise FreshError("Account preferences exceed the migration limit")
            for name in files:
                regular(Path(base) / name)
                count += 1
                if count > 10000:
                    raise FreshError("Account preferences exceed the migration limit")


def cache(file, *, clear=False):
    present = regular(file, optional=True) is not None
    sidecars = []
    for suffix in ("-wal", "-shm", "-journal"):
        if regular(Path(str(file) + suffix), optional=True) is not None:
            sidecars.append(suffix)
    if not present:
        if sidecars:
            raise FreshError("Orphaned authentication cache files need repair before Fresh migration")
        return
    try:
        uri = file.as_uri() + ("?mode=rw" if clear else "?mode=ro")
        with closing(sqlite3.connect(uri, uri=True, timeout=5)) as db:
            if db.execute("PRAGMA quick_check").fetchone() != ("ok",):
                raise FreshError("The controller cache needs repair before Fresh migration")
            tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()
            columns = db.execute("PRAGMA table_info(keyv)").fetchall()
            triggers = db.execute("SELECT count(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0]
            if tables != [("keyv",)] or [item[1] for item in columns] != ["key", "value"] or triggers:
                raise FreshError("An unknown cache format needs a separate Fresh migration review")
            if clear:
                db.execute("PRAGMA synchronous=FULL")
                db.execute("BEGIN IMMEDIATE")
                db.execute("DELETE FROM keyv")
                db.commit()
                if db.execute("SELECT count(*) FROM keyv").fetchone()[0]:
                    raise FreshError("Cached authentication could not be revoked")
    except sqlite3.Error:
        raise FreshError("The controller authentication cache could not be accessed") from None


def review(root, reader, raw, database):
    mounts = {item["Destination"]: item for item in raw["Mounts"]}
    paths = {"state": root / "state", "cache": root / "cache", "environment": root / ".env"}
    for name, destination in (("state", "/data/state"), ("cache", "/cache"), ("environment", "/data/.env")):
        mount = mounts.get(destination, {})
        if mount.get("Type") != "bind" or mount.get("Source") != str(paths[name]) or mount.get("RW") is not True:
            raise FreshError("Custom controller state mounts need a separate Fresh migration review")
    paths = {"state": directory(paths["state"]), "cache": directory(paths["cache"])}
    preference_directories(root / "state")
    cache(root / "cache/cache.sqlite")
    _, key, _, _ = environment(root)
    values = dict(item.split("=", 1) for item in raw["Config"].get("Env", []) if "=" in item)
    if values.get("JWT_SECRET") not in (None, key):
        raise FreshError("The running controller uses a different signing key from its environment file")
    compose_intent(root, reader)
    return {"paths": paths, "accounts": accounts(reader, database), "jwtHash": key_hash(key)}


def rotate_secret(root):
    text, _, match, info = environment(root)
    key = secrets.token_hex(64)
    value = text[:match.start()] + "JWT_SECRET=" + key + text[match.end():]
    descriptor, name = tempfile.mkstemp(prefix=".orbis-fresh-env-", dir=root)
    temporary = Path(name)
    try:
        os.fchmod(descriptor, 0o600)
        os.fchown(descriptor, info.st_uid, info.st_gid)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        shutil.copystat(root / ".env", temporary, follow_symlinks=False)
        fd = os.open(temporary, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, root / ".env")
        fd = os.open(root, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)
    return key_hash(key)


def reset(root, reader, database, reviewed):
    if {name: directory(root / name) for name in ("state", "cache")} != reviewed["paths"]:
        raise FreshError("Controller state directories changed since review")
    preference_directories(root / "state")
    before = accounts(reader, database)
    # Revoke all credential forms before account IDs can be reused.
    rotated = rotate_secret(root)
    cache(root / "cache/cache.sqlite", clear=True)
    for name in ("desktop", "onboarding"):
        target = root / "state" / name
        if target.exists():
            shutil.rmtree(target)
    fd = os.open(root / "state", os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    command = ["docker", "--context", reader.context, "exec", database, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "tipi", "-d", "tipi", "-Atqc", RESET_QUERY]
    result = subprocess.run(command, capture_output=True, timeout=45, check=False,
                            pass_fds=(reader.lock_fd,) if getattr(reader, "lock_fd", None) is not None else ())
    if result.returncode:
        raise FreshError("Fresh account reset failed; recover the stopped installation")
    after = accounts(reader, database)
    if after["users"] or after["links"] or any(before[name] != after[name] for name in ("apps", "stores")):
        raise FreshError("Fresh migration did not preserve the installed app metadata")
    if rotated == reviewed["jwtHash"]:
        raise FreshError("The controller signing key was not rotated")
    return {"accountsRemoved": before["users"], "linksRemoved": before["links"], "jwtHash": rotated, "apps": after["apps"], "stores": after["stores"], "cacheRevoked": True}
