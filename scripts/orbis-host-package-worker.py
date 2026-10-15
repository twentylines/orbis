#!/usr/bin/env python3
"""Run one reviewed APT transaction outside the browser and Orbis container.

systemd starts this worker as a separate unit so an Orbis core or host-helper
restart does not interrupt dpkg. It never refreshes indexes or reboots.
"""

import argparse
import importlib.util
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path


def load_service():
    spec = importlib.util.spec_from_file_location("orbis_host_service_for_package_worker", Path(__file__).with_name("orbis-host-service.py"))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SERVICE = load_service()
PACKAGES = SERVICE.PACKAGES
STATE_DIR = Path("/var/lib/orbis/state")


def plan_file(job_id: str) -> Path:
    uuid.UUID(job_id)
    return STATE_DIR / f"package-plan-{job_id}.json"


def job_file() -> Path:
    return STATE_DIR / "package-job.json"


def run(job_id: str) -> None:
    plan = SERVICE.read_private(plan_file(job_id))
    job = SERVICE.read_private(job_file())
    if (
        not plan
        or plan.get("schema") != "orbis.package-plan.v1"
        or plan.get("id") != job_id
        or not job
        or job.get("schema") != "orbis.package-job.v1"
        or job.get("id") != job_id
        or job.get("state") != "queued"
        or not isinstance(plan.get("createdAt"), (int, float))
        or time.time() - plan["createdAt"] > SERVICE.PLAN_TTL_SECONDS
        or not isinstance(plan.get("root"), str)
        or not isinstance(plan.get("selected"), list)
        or not isinstance(plan.get("operations"), list)
        or not all(isinstance(item, dict) and isinstance(item.get("name"), str) for item in plan["selected"])
    ):
        raise ValueError("reviewed package job is missing, changed, or expired")
    root = Path(plan["root"]).resolve(strict=True)
    if not root.is_dir() or plan.get("root") != str(root):
        raise ValueError("package job has an invalid installation root")
    with SERVICE.HOST.host_lock(root):
        if (STATE_DIR / "helper-maintenance.json").exists():
            raise ValueError("host helper maintenance is in progress")
        checked = PACKAGES.simulate_upgrades([item["name"] for item in plan["selected"]])
        if checked != {"selected": plan["selected"], "operations": plan["operations"]}:
            raise ValueError("APT package candidates changed; prepare a new plan")
        job["state"] = "running"
        job["startedAt"] = time.time()
        SERVICE.write_private(job_file(), job)
        command = PACKAGES.apt_apply_command(checked["selected"])
        environment = {
            "PATH": "/usr/bin:/bin",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "DEBIAN_FRONTEND": "noninteractive",
            "NEEDRESTART_MODE": "a",
            "HOME": "/root",
        }
        log_path = STATE_DIR / f"package-job-{job_id}.log"
        descriptor = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, env=environment, check=False)
            output.flush()
            os.fsync(output.fileno())
        job["finishedAt"] = time.time()
        job["exitCode"] = result.returncode
        job["rebootRequired"] = Path("/run/reboot-required").is_file()
        if result.returncode:
            job["state"] = "failed"
            job["message"] = "APT stopped with an error. Inspect the host package log and dpkg state before retrying."
        else:
            job["state"] = "complete"
            job["message"] = "APT installed the reviewed package transaction."
        SERVICE.write_private(job_file(), job)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job_id")
    args = parser.parse_args()
    try:
        run(args.job_id)
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        job = SERVICE.read_private(job_file())
        if job and job.get("id") == args.job_id and job.get("state") in {"queued", "running"}:
            job["state"] = "failed" if job["state"] == "queued" else "interrupted"
            job["finishedAt"] = time.time()
            job["message"] = "Package transaction needs local inspection before another update."
            SERVICE.write_private(job_file(), job)
        print(f"Orbis package worker stopped: {type(error).__name__}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
