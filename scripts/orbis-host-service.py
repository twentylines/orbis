#!/usr/bin/env python3
"""Expose only reviewed Orbis core updates over a local Unix socket.

Run this service outside the Orbis container. Socket file permissions are the
transport boundary; the web API must separately authenticate its user.
"""

import argparse
import http.server
import importlib.util
import json
import os
import re
import socket
import socketserver
import stat
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Callable


def load_script(name: str, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, Path(__file__).with_name(name))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


UPDATE = load_script("orbis-host-update.py", "orbis_update_for_service")
HOST = UPDATE.HOST
PLAN = HOST.PLAN
CHECK = UPDATE.CHECK
PLAN_TTL_SECONDS = 15 * 60
BODY_LIMIT = 4096


def write_private(path: Path, data: dict) -> None:
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    temporary = Path(name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(data, stream, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def read_private(path: Path) -> dict | None:
    if path.is_symlink():
        raise ValueError("host service state is a symlink")
    if not path.exists():
        return None
    if not path.is_file():
        raise ValueError("host service state is not a regular file")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("host service state is invalid")
    return data


def manifest_for_tag(tag: str) -> dict[str, str]:
    if not PLAN.TAG.fullmatch(tag):
        raise ValueError("release tag is invalid")
    published = CHECK.check(tag)
    image = published.get("image")
    if not isinstance(image, str) or not image.startswith(f"{PLAN.IMAGE}@"):
        raise ValueError("verified release has an unexpected image")
    return PLAN.validate_manifest(
        {
            "schema": "orbis.release.v1",
            "image": PLAN.IMAGE,
            "tag": tag,
            "commit": published["commit"],
            "digest": image.removeprefix(f"{PLAN.IMAGE}@"),
            "runtipiCompatibility": published["runtipiCompatibility"],
        }
    )


class HostService:
    def __init__(self, root: Path, context: str, snapshots: Path, state_dir: Path):
        self.root = root.resolve(strict=True)
        self.context = context
        self.snapshots = snapshots.resolve(strict=True)
        self.state_dir = state_dir.resolve(strict=True)
        if not self.root.is_dir() or not self.snapshots.is_dir() or not self.state_dir.is_dir():
            raise ValueError("host service paths must be directories")
        if self.snapshots.is_relative_to(self.root) or self.state_dir.is_relative_to(self.root):
            raise ValueError("host service state and snapshots must be outside the installation")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", context):
            raise ValueError("Docker context name is invalid")
        if stat.S_IMODE(self.state_dir.stat().st_mode) & 0o077:
            raise ValueError("host service state directory must be private (0700)")
        self.lock = threading.Lock()
        self.busy = False
        self.job_file = self.state_dir / "job.json"
        previous = read_private(self.job_file)
        if previous and previous.get("state") in {"running", "recovering"}:
            previous["state"] = "interrupted"
            write_private(self.job_file, previous)

    def state_matches(self, saved: dict | None) -> bool:
        if not saved or saved.get("root") != str(self.root) or saved.get("dockerContext") != self.context:
            return False
        files = saved.get("files")
        if not isinstance(files, dict):
            return False
        names = ("docker-compose.yml", ".env", "user-config/tipi-compose.yml", "orbis-compose.yml")
        return set(files) == set(names) and all(files[name] == HOST.file_digest(self.root / name) for name in names)

    def current_manifest(self) -> dict[str, str]:
        saved = HOST.saved_state(self.root)
        if not self.state_matches(saved) or not isinstance(saved.get("tag"), str) or not isinstance(saved.get("digest"), str):
            raise ValueError("this installation is not enrolled in Orbis")
        current = manifest_for_tag(saved["tag"])
        if current["digest"] != saved["digest"]:
            raise ValueError("the enrolled digest no longer matches its published release")
        return current

    def status(self) -> dict:
        saved = HOST.saved_state(self.root)
        enrolled = self.state_matches(saved)
        core = HOST.current_core(self.root, self.context)
        job = read_private(self.job_file)
        if job and job.get("state") == "interrupted":
            journal = read_private(UPDATE.journal_path(Path(job["snapshot"])))
            stage = journal.get("stage") if journal else None
            expected_digest = job["target"]["digest"] if stage == "complete" else job["current"]["digest"]
            healthy_expected = (
                enrolled
                and saved
                and saved.get("digest") == expected_digest
                and core.get("image") == f"{PLAN.IMAGE}@{expected_digest}"
                and core.get("health") == "healthy"
            )
            if stage in {"complete", "rolled-back"} and healthy_expected:
                job["state"] = "complete" if stage == "complete" else "rolled-back"
                job["message"] = "Reviewed Orbis release is healthy." if stage == "complete" else "Previous Orbis release is healthy."
                job["finishedAt"] = time.time()
                write_private(self.job_file, job)
            elif stage == "aborted":
                job["state"] = "failed"
                job["message"] = "Update stopped before service downtime."
                job["finishedAt"] = time.time()
                write_private(self.job_file, job)
        return {
            "available": True,
            "enrolled": enrolled,
            "currentTag": saved.get("tag") if saved else None,
            "currentDigest": saved.get("digest") if saved else None,
            "coreState": core.get("state"),
            "coreHealth": core.get("health"),
            "imageMatches": bool(enrolled and saved and core.get("image") == f"{PLAN.IMAGE}@{saved.get('digest')}"),
            "job": {key: job.get(key) for key in ("id", "state", "targetTag", "startedAt", "finishedAt", "message")}
            if job
            else None,
        }

    def plan(self, tag: str) -> dict:
        with self.lock:
            if self.busy:
                raise ValueError("another host update is in progress")
            previous = read_private(self.job_file)
            if previous and previous.get("state") in {"running", "recovering", "interrupted"}:
                raise ValueError("resolve the previous host update before creating another plan")
        current = self.current_manifest()
        target = manifest_for_tag(tag)
        plan_id = str(uuid.uuid4())
        snapshot = self.snapshots / f"orbis-{tag}-{plan_id}"
        result = UPDATE.update_plan(self.root, current, target, self.context, snapshot)
        record = {
            "schema": "orbis.host-service-plan.v1",
            "id": plan_id,
            "createdAt": time.time(),
            "current": current,
            "target": target,
            "snapshot": str(snapshot),
        }
        write_private(self.state_dir / f"plan-{plan_id}.json", record)
        return {
            "planId": plan_id,
            "currentTag": current["tag"],
            "targetTag": target["tag"],
            "targetDigest": target["digest"],
            "snapshotBytes": result["snapshotBytes"],
            "appsMustBeStopped": True,
        }

    def _read_plan(self, plan_id: str) -> dict:
        try:
            uuid.UUID(plan_id)
        except ValueError as error:
            raise ValueError("plan ID is invalid") from error
        record = read_private(self.state_dir / f"plan-{plan_id}.json")
        if (
            not record
            or record.get("schema") != "orbis.host-service-plan.v1"
            or record.get("id") != plan_id
            or not isinstance(record.get("createdAt"), (int, float))
            or time.time() - record["createdAt"] > PLAN_TTL_SECONDS
        ):
            raise ValueError("update plan is missing or expired; create a new plan")
        return record

    def apply(self, plan_id: str) -> tuple[dict, Callable[[], None]]:
        with self.lock:
            if self.busy:
                raise ValueError("another host update is in progress")
            previous = read_private(self.job_file)
            if previous and previous.get("state") in {"running", "recovering", "interrupted"}:
                raise ValueError("resolve the previous host update before applying another")
            plan = self._read_plan(plan_id)
            current = PLAN.validate_manifest(plan["current"])
            target = PLAN.validate_manifest(plan["target"])
            if self.current_manifest() != current:
                raise ValueError("installed release changed since the update plan")
            snapshot = Path(plan["snapshot"])
            if snapshot.parent != self.snapshots or snapshot.name != f"orbis-{target['tag']}-{plan_id}":
                raise ValueError("update plan has an invalid snapshot destination")
            UPDATE.update_plan(self.root, current, target, self.context, snapshot)
            job = {
                "schema": "orbis.host-service-job.v1",
                "id": plan_id,
                "state": "running",
                "targetTag": target["tag"],
                "startedAt": time.time(),
                "snapshot": str(snapshot),
                "current": current,
                "target": target,
            }
            write_private(self.job_file, job)
            self.busy = True

        def run() -> None:
            try:
                UPDATE.apply_update(self.root, current, target, self.context, snapshot)
                job["state"] = "complete"
                job["message"] = "Orbis reached the reviewed image and healthy state."
            except Exception:
                try:
                    journal = read_private(UPDATE.journal_path(snapshot))
                except (OSError, ValueError, json.JSONDecodeError):
                    journal = None
                stage = journal.get("stage") if journal else None
                job["state"] = "rolled-back" if stage == "rolled-back" else "failed" if stage in {None, "aborted"} else "interrupted"
                job["message"] = (
                    "The previous Orbis release was restored."
                    if job["state"] == "rolled-back"
                    else "Update stopped before service downtime."
                    if job["state"] == "failed"
                    else "Update needs local inspection or recovery."
                )
            finally:
                job["finishedAt"] = time.time()
                try:
                    write_private(self.job_file, job)
                finally:
                    with self.lock:
                        self.busy = False

        return {"jobId": plan_id, "state": "running"}, lambda: threading.Thread(target=run, daemon=True).start()

    def recover(self, job_id: str) -> tuple[dict, Callable[[], None]]:
        with self.lock:
            if self.busy:
                raise ValueError("another host update is in progress")
            job = read_private(self.job_file)
            if not job or job.get("id") != job_id or job.get("state") != "interrupted":
                raise ValueError("there is no interrupted transaction for this job ID")
            current = PLAN.validate_manifest(job["current"])
            target = PLAN.validate_manifest(job["target"])
            snapshot = Path(job["snapshot"])
            if snapshot.parent != self.snapshots or snapshot.name != f"orbis-{target['tag']}-{job_id}":
                raise ValueError("interrupted job has an invalid snapshot destination")
            journal = UPDATE.read_journal(snapshot, self.root, self.context, current, target)
            if journal.get("stage") in UPDATE.TERMINAL_STAGES:
                raise ValueError("transaction already finished; refresh status")
            job["state"] = "recovering"
            write_private(self.job_file, job)
            self.busy = True

        def run() -> None:
            try:
                UPDATE.recover(self.root, current, target, self.context, snapshot)
                job["state"] = "rolled-back"
                job["message"] = "Previous Orbis release is healthy."
            except Exception:
                job["state"] = "interrupted"
                job["message"] = "Recovery needs local inspection."
            finally:
                job["finishedAt"] = time.time()
                try:
                    write_private(self.job_file, job)
                finally:
                    with self.lock:
                        self.busy = False

        return {"jobId": job_id, "state": "recovering"}, lambda: threading.Thread(target=run, daemon=True).start()


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class Handler(http.server.BaseHTTPRequestHandler):
    server: UnixHTTPServer

    def log_message(self, format: str, *args: object) -> None:
        pass

    def send_json(self, status: int, data: dict) -> None:
        body = json.dumps(data, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def body(self) -> dict:
        length = self.headers.get("Content-Length", "")
        if not length.isascii() or not length.isdecimal() or not 0 < int(length) <= BODY_LIMIT:
            raise ValueError("request body length is invalid")
        data = json.loads(self.rfile.read(int(length)))
        if not isinstance(data, dict):
            raise ValueError("request body must be an object")
        return data

    def do_GET(self) -> None:
        if self.path != "/v1/status":
            self.send_json(404, {"error": "not found"})
            return
        try:
            self.send_json(200, self.server.service.status())
        except (OSError, ValueError, RuntimeError):
            self.send_json(503, {"error": "host status is unavailable"})

    def do_POST(self) -> None:
        if self.path not in {"/v1/plan", "/v1/apply", "/v1/recover"}:
            self.send_json(404, {"error": "not found"})
            return
        try:
            data = self.body()
            if self.path == "/v1/plan":
                if set(data) != {"tag"} or not isinstance(data["tag"], str):
                    raise ValueError("request must contain one release tag")
                self.send_json(200, self.server.service.plan(data["tag"]))
            elif self.path == "/v1/apply":
                if set(data) != {"planId"} or not isinstance(data["planId"], str):
                    raise ValueError("request must contain one plan ID")
                result, launch = self.server.service.apply(data["planId"])
                try:
                    self.send_json(202, result)
                finally:
                    launch()
            else:
                if set(data) != {"jobId"} or not isinstance(data["jobId"], str):
                    raise ValueError("request must contain one job ID")
                result, launch = self.server.service.recover(data["jobId"])
                try:
                    self.send_json(202, result)
                finally:
                    launch()
        except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
            self.send_json(409, {"error": str(error) if isinstance(error, ValueError) else "host operation could not start"})


def serve(socket_path: Path, service: HostService) -> None:
    parent = socket_path.parent.resolve(strict=True)
    if not parent.is_dir() or stat.S_IMODE(parent.stat().st_mode) & 0o022:
        raise ValueError("host socket parent must not be writable by other users")
    if socket_path.exists() or socket_path.is_symlink():
        existing = socket_path.lstat()
        if not stat.S_ISSOCK(existing.st_mode) or existing.st_uid != os.getuid():
            raise ValueError("host socket path is occupied by another file")
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.settimeout(0.5)
            probe.connect(str(socket_path))
        except ConnectionRefusedError:
            socket_path.unlink()
        else:
            raise ValueError("another Orbis host service is already listening")
        finally:
            probe.close()
    old_umask = os.umask(0o177)
    try:
        server = UnixHTTPServer(str(socket_path), Handler)
    finally:
        os.umask(old_umask)
    server.service = service
    try:
        os.chmod(socket_path, 0o600)
        try:
            server.serve_forever(poll_interval=0.5)
        except KeyboardInterrupt:
            pass
    finally:
        server.server_close()
        socket_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--docker-context", required=True)
    parser.add_argument("--socket", required=True, type=Path)
    parser.add_argument("--snapshots", required=True, type=Path)
    parser.add_argument("--state-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        service = HostService(args.root, args.docker_context, args.snapshots, args.state_dir)
        serve(args.socket, service)
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Orbis host service failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
