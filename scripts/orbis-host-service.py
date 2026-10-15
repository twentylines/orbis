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
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, urlsplit


def load_script(name: str, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, Path(__file__).with_name(name))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


UPDATE = load_script("orbis-host-update.py", "orbis_update_for_service")
PACKAGES = load_script("orbis-host-packages.py", "orbis_packages_for_service")
HOST = UPDATE.HOST
PLAN = HOST.PLAN
CHECK = UPDATE.CHECK
PLAN_TTL_SECONDS = 15 * 60
BODY_LIMIT = 64 * 1024


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
        self.package_job_file = self.state_dir / "package-job.json"
        self.maintenance_file = self.state_dir / "helper-maintenance.json"
        previous = read_private(self.job_file)
        if previous and previous.get("state") in {"running", "recovering"}:
            previous["state"] = "interrupted"
            write_private(self.job_file, previous)

    def require_package_clear(self) -> None:
        job = read_private(self.package_job_file)
        if job and job.get("state") in {"queued", "running", "failed", "interrupted"}:
            raise ValueError("resolve the host package transaction before changing the Orbis core")

    def require_healthy_core(self) -> None:
        current = self.status()
        if not (
            current["enrolled"]
            and current["imageMatches"]
            and current["coreState"] == "running"
            and current["coreHealth"] == "healthy"
        ):
            raise ValueError("host package changes require a healthy enrolled Orbis core")

    def package_job_status(self) -> dict:
        job = read_private(self.package_job_file)
        if job and job.get("state") in {"queued", "running"}:
            if not isinstance(job.get("createdAt"), (int, float)):
                raise ValueError("package job record is invalid")
            if time.time() - job["createdAt"] <= 5:
                return {"available": True, "job": {key: job.get(key) for key in ("id", "state", "createdAt", "startedAt", "finishedAt", "message", "exitCode", "rebootRequired", "operationCount")}}
            identifier = job.get("id")
            if not isinstance(identifier, str):
                raise ValueError("package job record is invalid")
            uuid.UUID(identifier)
            unit = f"orbis-package-{identifier}.service"
            result = subprocess.run(
                ["/usr/bin/systemctl", "show", "-p", "ActiveState", "--value", unit],
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
            )
            if result.returncode or result.stdout.strip() not in {"active", "activating"}:
                refreshed = read_private(self.package_job_file)
                if refreshed and refreshed.get("id") == identifier and refreshed.get("state") in {"queued", "running"}:
                    refreshed["state"] = "interrupted"
                    refreshed["finishedAt"] = time.time()
                    refreshed["message"] = "The package worker stopped without recording completion. Inspect APT and dpkg locally."
                    write_private(self.package_job_file, refreshed)
                    job = refreshed
                else:
                    job = refreshed
        return {
            "available": True,
            "job": {key: job.get(key) for key in ("id", "state", "createdAt", "startedAt", "finishedAt", "message", "exitCode", "rebootRequired", "operationCount")}
            if job
            else None,
        }

    def package_plan(self, names: list[str]) -> dict:
        with self.lock:
            self.require_healthy_core()
            if self.maintenance_file.exists() or self.maintenance_file.is_symlink():
                raise ValueError("host helper maintenance is in progress")
            if self.busy:
                raise ValueError("another host update is in progress")
            core_job = read_private(self.job_file)
            if core_job and core_job.get("state") in {"running", "recovering", "interrupted"}:
                raise ValueError("resolve the Orbis core update before planning host packages")
            package_job = self.package_job_status()["job"]
            if package_job and package_job.get("state") in {"queued", "running", "failed", "interrupted"}:
                raise ValueError("resolve the previous host package transaction first")
            simulation = PACKAGES.simulate_upgrades(names)
            plan_id = str(uuid.uuid4())
            record = {
                "schema": "orbis.package-plan.v1",
                "id": plan_id,
                "root": str(self.root),
                "createdAt": time.time(),
                **simulation,
            }
            write_private(self.state_dir / f"package-plan-{plan_id}.json", record)
            return {"planId": plan_id, "createdAt": record["createdAt"], **simulation}

    def package_apply(self, plan_id: str) -> dict:
        with self.lock:
            self.require_healthy_core()
            if self.maintenance_file.exists() or self.maintenance_file.is_symlink():
                raise ValueError("host helper maintenance is in progress")
            if self.busy:
                raise ValueError("another host update is in progress")
            core_job = read_private(self.job_file)
            if core_job and core_job.get("state") in {"running", "recovering", "interrupted"}:
                raise ValueError("resolve the Orbis core update before installing host packages")
            package_job = self.package_job_status()["job"]
            if package_job and package_job.get("state") in {"queued", "running", "failed", "interrupted"}:
                raise ValueError("resolve the previous host package transaction first")
            try:
                uuid.UUID(plan_id)
            except (TypeError, ValueError) as error:
                raise ValueError("package plan ID is invalid") from error
            if package_job and package_job.get("id") == plan_id:
                raise ValueError("package plan was already applied; prepare a new plan")
            plan = read_private(self.state_dir / f"package-plan-{plan_id}.json")
            if (
                not plan
                or plan.get("schema") != "orbis.package-plan.v1"
                or plan.get("id") != plan_id
                or plan.get("root") != str(self.root)
                or not isinstance(plan.get("createdAt"), (int, float))
                or time.time() - plan["createdAt"] > PLAN_TTL_SECONDS
                or not isinstance(plan.get("selected"), list)
                or not isinstance(plan.get("operations"), list)
            ):
                raise ValueError("package plan is missing, changed, or expired")
            current = PACKAGES.simulate_upgrades([item["name"] for item in plan["selected"]])
            if current != {"selected": plan["selected"], "operations": plan["operations"]}:
                raise ValueError("APT package candidates changed; prepare a new plan")
            job = {
                "schema": "orbis.package-job.v1",
                "id": plan_id,
                "state": "queued",
                "createdAt": time.time(),
                "operationCount": len(plan["operations"]),
            }
            write_private(self.package_job_file, job)
            command = [
                "/usr/bin/systemd-run",
                f"--unit=orbis-package-{plan_id}",
                "--collect",
                "--property=Type=exec",
                "/usr/bin/python3",
                str(Path(__file__).with_name("orbis-host-package-worker.py")),
                plan_id,
            ]
            try:
                result = subprocess.run(command, capture_output=True, text=True, timeout=10, check=False)
            except (OSError, subprocess.TimeoutExpired):
                result = None
            if not result or result.returncode:
                job["state"] = "failed"
                job["finishedAt"] = time.time()
                job["message"] = "The isolated package worker could not start. No APT installation was requested."
                write_private(self.package_job_file, job)
                raise RuntimeError("the isolated package worker could not start")
            return {"jobId": plan_id, "state": "queued"}

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
                job.update(UPDATE.safe_failure(journal))
                job["message"] = "Reviewed Orbis release is healthy." if stage == "complete" else f"{UPDATE.failure_message(journal)} Previous Orbis release is healthy.".strip()
                job["finishedAt"] = time.time()
                write_private(self.job_file, job)
            elif stage == "aborted":
                job["state"] = "failed"
                job.update(UPDATE.safe_failure(journal))
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
            "job": {key: job.get(key) for key in ("id", "state", "targetTag", "startedAt", "finishedAt", "message")} | UPDATE.safe_failure(job)
            if job
            else None,
        }

    def plan(self, tag: str) -> dict:
        with self.lock:
            self.require_package_clear()
            if self.maintenance_file.exists() or self.maintenance_file.is_symlink():
                raise ValueError("host helper maintenance is in progress")
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
            self.require_package_clear()
            if self.maintenance_file.exists() or self.maintenance_file.is_symlink():
                raise ValueError("host helper maintenance is in progress")
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
                job.update(UPDATE.safe_failure(journal))
                job["state"] = "rolled-back" if stage == "rolled-back" else "failed" if stage in {None, "aborted"} else "interrupted"
                job["message"] = (
                    f"{UPDATE.failure_message(journal)} The previous Orbis release was restored.".strip()
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
            self.require_package_clear()
            if self.maintenance_file.exists() or self.maintenance_file.is_symlink():
                raise ValueError("host helper maintenance is in progress")
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
                journal = read_private(UPDATE.journal_path(snapshot))
                job.update(UPDATE.safe_failure(journal))
                job["message"] = f"{UPDATE.failure_message(journal)} Previous Orbis release is healthy.".strip()
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
        if self.path == "/v1/status":
            try:
                self.send_json(200, self.server.service.status())
            except (OSError, ValueError, RuntimeError):
                self.send_json(503, {"error": "host status is unavailable"})
            return
        if self.path == "/v1/packages":
            try:
                self.send_json(200, PACKAGES.inventory())
            except ValueError as error:
                self.send_json(200, {"available": False, "reason": str(error)})
            except (OSError, RuntimeError, SystemError):
                self.send_json(503, {"error": "host package inventory is unavailable"})
            return
        if self.path == "/v1/packages/job":
            try:
                self.send_json(200, self.server.service.package_job_status())
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
                self.send_json(503, {"error": "host package job status is unavailable"})
            return
        parsed = urlsplit(self.path)
        if parsed.path != "/v1/packages/changelog" or parsed.fragment:
            self.send_json(404, {"error": "not found"})
            return
        try:
            parameters = parse_qs(parsed.query, keep_blank_values=True)
            if set(parameters) != {"name"} or len(parameters["name"]) != 1:
                raise ValueError("choose one package name")
            self.send_json(200, PACKAGES.changelog(parameters["name"][0]))
        except ValueError as error:
            self.send_json(409, {"error": str(error)})
        except (OSError, RuntimeError, SystemError):
            self.send_json(503, {"error": "package changelog is unavailable"})

    def do_POST(self) -> None:
        if self.path not in {"/v1/plan", "/v1/apply", "/v1/recover", "/v1/packages/plan", "/v1/packages/apply"}:
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
            elif self.path == "/v1/recover":
                if set(data) != {"jobId"} or not isinstance(data["jobId"], str):
                    raise ValueError("request must contain one job ID")
                result, launch = self.server.service.recover(data["jobId"])
                try:
                    self.send_json(202, result)
                finally:
                    launch()
            elif self.path == "/v1/packages/plan":
                if set(data) != {"names"} or not isinstance(data["names"], list):
                    raise ValueError("request must contain a package name list")
                self.send_json(200, self.server.service.package_plan(data["names"]))
            else:
                if set(data) != {"planId"} or not isinstance(data["planId"], str):
                    raise ValueError("request must contain one package plan ID")
                self.send_json(202, self.server.service.package_apply(data["planId"]))
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
