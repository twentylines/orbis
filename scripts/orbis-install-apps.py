#!/usr/bin/env python3
"""Quiesce and resume the reviewed apps of one Runtipi/Orbis installation.

This host-side transaction is a building block for the installer. It does not
replace a controller or back up data. A caller taking a snapshot must separately
stop the controller and verify every other writer and external storage path.
"""

import argparse
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
from pathlib import Path


def load_script(name: str, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, Path(__file__).with_name(name))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DETECT = load_script("orbis-install-detect.py", "orbis_discovery_for_apps")
HOST = load_script("orbis-host.py", "orbis_host_for_install_apps")
SCHEMA = "orbis.installation-apps.v1"
STAGES = {"prepared", "quiescing", "quiesced", "resuming", "resumed"}
APP_FORMAT = (
    '{"id":{{json .Id}},"name":{{json .Name}},"imageId":{{json .Image}},'
    '"image":{{json .Config.Image}},"labels":{{json .Config.Labels}},'
    '"mounts":{{json .Mounts}},"state":{{json .State.Status}},'
    '"autoRemove":{{json .HostConfig.AutoRemove}},'
    '"stopTimeout":{{json (index .Config "StopTimeout")}},'
    '"restartPolicy":{{json .HostConfig.RestartPolicy}}}'
)
POLICIES = {"no", "always", "unless-stopped", "on-failure"}
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}")
TARGET_IMAGE = re.compile(r"ghcr\.io/twentylines/orbis@sha256:[0-9a-f]{64}")


class AppError(ValueError):
    pass


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def policy(value: object) -> dict:
    if (
        not isinstance(value, dict) or set(value) != {"Name", "MaximumRetryCount"}
        or not isinstance(value["Name"], str) or value["Name"] not in POLICIES
        or type(value["MaximumRetryCount"]) is not int
        or not 0 <= value["MaximumRetryCount"] <= 2**31 - 1
        or (value["Name"] != "on-failure" and value["MaximumRetryCount"] != 0)
    ):
        raise AppError("An app has an unsupported Docker restart policy")
    return value


class Docker(DETECT.DockerReader):
    def app(self, identifier: str) -> dict:
        if not DETECT.IDENTIFIER.fullmatch(identifier):
            raise AppError("An app container identity is invalid")
        return self._object(["container", "inspect", "--format", APP_FORMAT, identifier])

    def change(self, arguments: list[str], timeout: int = 90) -> None:
        try:
            result = subprocess.run(
                ["docker", "--context", self.context, "container", *arguments],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                check=False, timeout=timeout,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RuntimeError("Docker did not finish the app operation; inspect the saved transaction before retrying") from error
        if result.returncode:
            raise RuntimeError("Docker could not change an app container; its recovery record has been retained")


def app_record(raw: dict) -> dict:
    if (
        not isinstance(raw, dict) or not DETECT.IDENTIFIER.fullmatch(str(raw.get("id", "")))
        or not IMAGE_ID.fullmatch(str(raw.get("imageId", "")))
        or not isinstance(raw.get("labels"), dict)
        or str(raw["labels"].get("runtipi.managed", "")).lower() != "true"
        or not isinstance(raw.get("name"), str) or not re.fullmatch(r"/[A-Za-z0-9][A-Za-z0-9_.-]*", raw["name"])
        or not isinstance(raw.get("image"), str) or not raw["image"]
    ):
        raise AppError("Docker returned invalid app ownership or identity")
    DETECT.validate_mounts(raw.get("mounts"))
    if raw.get("state") not in {"running", "exited", "created"}:
        raise AppError("Wait for app containers to finish starting, restarting or stopping before installation")
    if raw.get("autoRemove") is not False:
        raise AppError("An automatically removed app container cannot be preserved for installation recovery")
    timeout = raw.get("stopTimeout")
    if timeout is not None and (type(timeout) is not int or not 0 <= timeout <= 3600):
        raise AppError("An app has an unbounded or unsupported stop timeout")
    identity = {key: raw[key] for key in ("id", "name", "imageId", "image", "labels", "mounts", "autoRemove", "stopTimeout")}
    # Docker may reorder Mounts between inspections of the same container.
    identity["mounts"] = sorted(raw["mounts"], key=lambda mount: mount["Destination"])
    return {
        "id": raw["id"], "name": raw["name"][1:],
        "appUrn": DETECT.text(raw["labels"].get("runtipi.appurn", "")) or None,
        "definitionHash": digest(identity), "originalState": raw["state"],
        "restartPolicy": policy(raw.get("restartPolicy")),
        "stopTimeout": timeout,
    }


def selected_installation(reader: Docker, root: Path) -> tuple[dict, dict]:
    report = DETECT.discover(reader)
    selected = [item for item in report["installations"] if item["installRoot"] == str(root)]
    if len(selected) != 1 or selected[0]["reviewRequired"]:
        raise AppError("The selected installation could not be identified unambiguously")
    if report["unassignedManagedContainers"]:
        raise AppError("Unassigned managed containers need review before apps can be stopped")
    return report, selected[0]


def plan(root: Path, reader: Docker) -> dict:
    report, installation = selected_installation(reader, root)
    apps = []
    for item in installation["apps"]:
        identifier = item["container"]["id"]
        record = app_record(reader.app(identifier))
        if record["id"] != identifier or record["originalState"] != item["container"]["state"]:
            raise AppError("An app changed during inspection; review the installation again")
        apps.append(record)
    value = {
        "schema": SCHEMA, "root": str(root), "dockerContext": reader.context,
        "daemonFingerprint": report["daemonFingerprint"],
        "installationId": installation["id"],
        "controller": {
            "image": next(row["image"] for row in reader.containers() if row["id"] == installation["container"]["id"]),
            "imageId": reader.core(installation["container"]["id"])["imageId"],
        },
        "apps": sorted(apps, key=lambda item: item["id"]),
    }
    # Discovery and each extra inspection must describe the same reviewed set.
    after_report, after_installation = selected_installation(reader, root)
    if after_report != report or after_installation != installation:
        raise AppError("Docker changed while the app plan was being prepared")
    value["reviewId"] = digest(value)
    return value


def journal_path(path: Path, root: Path) -> Path:
    parent = path.parent.resolve(strict=True)
    if path.is_symlink() or path.name in {"", ".", ".."} or parent.is_relative_to(root) or root.is_relative_to(parent / path.name):
        raise AppError("The app journal must be a regular file outside the installation")
    metadata = parent.stat()
    if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
        raise AppError("The app journal needs a private directory owned by the installer user")
    return parent / path.name


def write_journal(path: Path, record: dict) -> None:
    if path.exists() or path.is_symlink():
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
            raise AppError("The app journal is not a private regular file")
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    temporary = Path(name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(record, stream, indent=2)
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


def read_journal(path: Path, root: Path, context: str) -> dict:
    path = journal_path(path, root)
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
        raise AppError("The app journal is not a private regular file")
    if metadata.st_size > 8 * 1024 * 1024:
        raise AppError("The app journal exceeds its size limit")
    record = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(record, dict) or record.get("schema") != SCHEMA or not isinstance(record.get("stage"), str) or record["stage"] not in STAGES:
        raise AppError("The app journal format is invalid")
    value = record.get("plan")
    if not isinstance(value, dict) or value.get("schema") != SCHEMA or value.get("root") != str(root) or value.get("dockerContext") != context:
        raise AppError("The app journal belongs to another installation or Docker context")
    unsigned = {key: item for key, item in value.items() if key != "reviewId"}
    if value.get("reviewId") != digest(unsigned):
        raise AppError("The saved app review does not match its fingerprint")
    controller = value.get("controller")
    if (
        not DETECT.IDENTIFIER.fullmatch(str(value.get("daemonFingerprint", "")))
        or not DETECT.IDENTIFIER.fullmatch(str(value.get("installationId", "")))
        or not isinstance(controller, dict) or not isinstance(controller.get("image"), str)
        or DETECT.image_brand(controller["image"]) not in {"runtipi", "orbis"}
        or not IMAGE_ID.fullmatch(str(controller.get("imageId", "")))
    ):
        raise AppError("The saved installation or controller identity is invalid")
    if not isinstance(value.get("apps"), list) or len(value["apps"]) > 4096:
        raise AppError("The saved app list is invalid")
    identifiers = set()
    for app in value["apps"]:
        if (
            not isinstance(app, dict) or not DETECT.IDENTIFIER.fullmatch(str(app.get("id", "")))
            or app["id"] in identifiers or not isinstance(app.get("originalState"), str)
            or app["originalState"] not in {"running", "created", "exited"}
            or not DETECT.IDENTIFIER.fullmatch(str(app.get("definitionHash", "")))
            or not isinstance(app.get("name"), str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", app["name"])
        ):
            raise AppError("The saved app identity or state is invalid")
        DETECT.text(app.get("appUrn") or "")
        timeout = app.get("stopTimeout")
        if timeout is not None and (type(timeout) is not int or not 0 <= timeout <= 3600):
            raise AppError("The saved app stop timeout is invalid")
        policy(app.get("restartPolicy"))
        identifiers.add(app["id"])
    return record


def current_apps(reader: Docker, root: Path, saved: dict, require_original_controller: bool) -> dict[str, dict]:
    report, installation = selected_installation(reader, root)
    if report["daemonFingerprint"] != saved["daemonFingerprint"]:
        raise AppError("The Docker daemon differs from the reviewed installation")
    if require_original_controller and installation["id"] != saved["installationId"]:
        raise AppError("The controller changed before the app stop completed")
    expected = {item["id"]: item for item in saved["apps"]}
    actual = {item["container"]["id"] for item in installation["apps"]}
    if actual != set(expected):
        raise AppError("The installed app containers changed; keep the recovery record and review Docker locally")
    return {identifier: current_app(reader, saved, original) for identifier, original in expected.items()}


def current_app(reader: Docker, saved: dict, original: dict) -> dict:
    if digest_daemon(reader) != saved["daemonFingerprint"]:
        raise AppError("The Docker daemon differs from the reviewed installation")
    app = app_record(reader.app(original["id"]))
    if app["definitionHash"] != original["definitionHash"]:
        raise AppError("An app definition changed since it was reviewed")
    if app["restartPolicy"] not in [original["restartPolicy"], {"Name": "no", "MaximumRetryCount": 0}]:
        raise AppError("An app restart policy changed outside this installation transaction")
    return app


def digest_daemon(reader: Docker) -> str:
    return hashlib.sha256(reader.daemon().encode()).hexdigest()


def stop(root: Path, reader: Docker, path: Path, review_id: str) -> dict:
    path = journal_path(path, root)
    if path.exists():
        raise AppError("An app transaction already exists at this journal path; do not repeat stop")
    value = plan(root, reader)
    if review_id != value["reviewId"]:
        raise AppError("The app plan changed; review the new plan before stopping anything")
    record = {"schema": SCHEMA, "stage": "prepared", "plan": value}
    write_journal(path, record)
    record["stage"] = "quiescing"
    write_journal(path, record)
    for original in value["apps"]:
        current_app(reader, value, original)
        reader.change(["update", "--restart", "no", original["id"]])
    current_apps(reader, root, value, require_original_controller=True)
    for original in value["apps"]:
        current_app(reader, value, original)
        if original["originalState"] == "running":
            reader.change(["stop", original["id"]], timeout=max(90, (original["stopTimeout"] or 10) + 30))
    current = current_apps(reader, root, value, require_original_controller=True)
    if any(app["originalState"] == "running" or app["restartPolicy"]["Name"] != "no" for app in current.values()):
        raise RuntimeError("App containers are not quiesced; keep the saved transaction for recovery")
    record["stage"] = "quiesced"
    write_journal(path, record)
    return {"result": "apps-quiesced", "journal": str(path), "containers": len(value["apps"]), "runningContainersStopped": sum(app["originalState"] == "running" for app in value["apps"])}


def require_healthy_controller(root: Path, reader: Docker, saved: dict, expected_image: str | None, identifier: str | None = None) -> str:
    image = expected_image or saved["controller"]["image"]
    if image != saved["controller"]["image"] and not TARGET_IMAGE.fullmatch(image):
        raise AppError("Resume needs the original controller or an immutable Orbis image")
    if identifier is None:
        _, installation = selected_installation(reader, root)
        identifier = installation["container"]["id"]
    actual = reader._object([
        "container", "inspect", "--format",
        '{"image":{{json .Config.Image}},"imageId":{{json .Image}},"state":{{json .State}}}', identifier,
    ])
    if (
        actual.get("image") != image or not isinstance(actual.get("state"), dict)
        or actual["state"].get("Status") != "running"
        or (actual["state"].get("Health") or {}).get("Status") != "healthy"
        or (image == saved["controller"]["image"] and actual.get("imageId") != saved["controller"]["imageId"])
    ):
        raise AppError("The reviewed controller must be healthy before apps can resume")
    return identifier


def resume(root: Path, reader: Docker, path: Path, expected_image: str | None = None) -> dict:
    path = journal_path(path, root)
    record = read_journal(path, root, reader.context)
    if record["stage"] == "resumed":
        raise AppError("This app transaction has already resumed; it cannot be replayed")
    value = record["plan"]
    current = current_apps(reader, root, value, require_original_controller=False)
    controller_id = require_healthy_controller(root, reader, value, expected_image)
    if any(app["originalState"] != "running" and current[app["id"]]["originalState"] == "running" for app in value["apps"]):
        raise AppError("A previously stopped app is running unexpectedly; review it before recovery")
    record["stage"] = "resuming"
    write_journal(path, record)
    for original in value["apps"]:
        current = current_app(reader, value, original)
        require_healthy_controller(root, reader, value, expected_image, controller_id)
        identifier = original["id"]
        if original["originalState"] == "running" and current["originalState"] != "running":
            reader.change(["start", identifier])
        original_policy = original["restartPolicy"]
        setting = original_policy["Name"]
        if setting == "on-failure" and original_policy["MaximumRetryCount"]:
            setting += f":{original_policy['MaximumRetryCount']}"
        reader.change(["update", "--restart", setting, identifier])
    current = current_apps(reader, root, value, require_original_controller=False)
    require_healthy_controller(root, reader, value, expected_image, controller_id)
    if any(
        (current[app["id"]]["originalState"] == "running") != (app["originalState"] == "running")
        or current[app["id"]]["restartPolicy"] != app["restartPolicy"]
        for app in value["apps"]
    ):
        raise RuntimeError("App running states or restart policies did not recover; keep the transaction")
    record["stage"] = "resumed"
    write_journal(path, record)
    return {"result": "apps-resumed", "journal": str(path), "containers": len(value["apps"])}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("plan", "stop", "resume"))
    parser.add_argument("root", type=Path)
    parser.add_argument("--docker-context", required=True)
    parser.add_argument("--journal", type=Path, help="new JSON file in a private directory outside the installation")
    parser.add_argument("--review-id", help="exact fingerprint returned by plan, required for stop")
    parser.add_argument("--confirm-root", help="exact resolved root, required for stop and resume")
    parser.add_argument("--controller-image", help="immutable Orbis image for resume after replacement; otherwise require the original image")
    args = parser.parse_args()
    try:
        root = args.root.expanduser().resolve(strict=True)
        if not root.is_dir() or root == Path("/"):
            raise AppError("The installation root must be an existing directory")
        reader = Docker(args.docker_context)
        if args.action == "plan":
            result = plan(root, reader)
        else:
            HOST.require_confirmation(root, args.confirm_root)
            if args.journal is None or (args.action == "stop" and args.review_id is None):
                raise AppError("A private journal and the reviewed plan are required before stopping apps")
            with HOST.host_lock(root):
                result = stop(root, reader, args.journal.expanduser(), args.review_id) if args.action == "stop" else resume(root, reader, args.journal.expanduser(), args.controller_image)
        print(json.dumps(result, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, StopIteration) as error:
        # Docker errors and untrusted file contents must never enter installer output.
        message = str(error) if isinstance(error, (AppError, DETECT.InspectionError)) else "The app operation could not finish; inspect the private journal before taking further action"
        print(json.dumps({"schema": SCHEMA, "result": "app-operation-failed", "message": message}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
