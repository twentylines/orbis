#!/usr/bin/env python3
"""Replace a reviewed Runtipi controller, retaining its data and rollback copy.

Run on the Linux Docker host. The original controller remains stopped until
the replacement passes hold/resume checks. Before public activation, recovery
rolls back; after activation begins, recovery finishes the recorded cutover.
"""

import argparse
import copy
import http.client
import importlib.util
import json
import os
import re
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path


def load(name, key):
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(name))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TX = load("orbis-install-transaction.py", "orbis_transaction_for_replacement")
COMPAT = load("orbis-install-compat.py", "orbis_compat_for_replacement")
UPDATE = load("orbis-host-update.py", "orbis_update_for_replacement")
APPS = TX.APPS
HOST = APPS.HOST
SCHEMA = "orbis.installation-replacement.v1"
TERMINAL = {"complete", "rolled-back"}
PRECOMMIT = {"prepared", "checkpointing", "checkpointed", "retaining-original", "holding", "held", "resuming", "resumed", "rolling-back"}


class ReplacementError(ValueError):
    pass


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, endpoint):
        super().__init__("localhost", timeout=30)
        self.endpoint = endpoint

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.endpoint)


class Engine:
    def __init__(self, reader):
        self.endpoint = reader.socket()
        if not self.endpoint or not Path(self.endpoint).is_socket():
            raise ReplacementError("Replacement requires the selected local Docker socket")
        version = reader._read(["version", "--format", "{{.Server.APIVersion}}"])
        if not re.fullmatch(r"1\.[0-9]{2,3}", version) or int(version.split(".")[1]) < 44:
            raise ReplacementError("Replacement requires Docker Engine API 1.44 or newer")
        self.version = version

    def create(self, name, body):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name):
            raise ReplacementError("The replacement container name is invalid")
        connection = UnixConnection(self.endpoint)
        try:
            connection.request("POST", f"/v{self.version}/containers/create?name={name}", json.dumps(body).encode(), {"Content-Type": "application/json"})
            response = connection.getresponse()
            data = response.read(1024 * 1024 + 1)
            if response.status != 201 or len(data) > 1024 * 1024:
                raise ReplacementError("Docker could not create the reviewed controller; inspect the private journal")
            value = json.loads(data)
            if not re.fullmatch(r"[0-9a-f]{64}", str(value.get("Id", ""))):
                raise ReplacementError("Docker returned an invalid replacement identity")
            return value["Id"]
        finally:
            connection.close()


def inspect(reader, identifier):
    return reader._object(["container", "inspect", "--format", "{{json .}}", identifier])


def role(value, name):
    return next(key for key, item in value["checkpoint"]["roles"].items() if item == name)


def target_image(target):
    return f"{target['image']}@{target['digest']}"


def files(root):
    return {name: HOST.file_digest(root / name) for name in ("docker-compose.yml", ".env", "VERSION", "user-config/tipi-compose.yml", "orbis-compose.yml")}


def checkpoint_path(journal):
    return Path(str(journal) + ".checkpoint.json")


def validate_review(value):
    if not isinstance(value, dict) or value.get("schema") != SCHEMA or value.get("reviewId") != APPS.digest({key: item for key, item in value.items() if key != "reviewId"}):
        raise ReplacementError("The replacement review is invalid or was edited")
    TX.validate_review(value["checkpoint"])
    HOST.PLAN.require_installation_protocol(value["target"])
    COMPAT.require_compatible(value["database"]["ledger"], value["image"]["ledger"])
    if value["mode"] != "keep" or value["root"] != value["checkpoint"]["root"] or value["dockerContext"] != value["checkpoint"]["dockerContext"]:
        raise ReplacementError("The replacement review has an unsupported mode or installation")
    if value["checkpoint"]["journal"] != str(checkpoint_path(value["journal"])):
        raise ReplacementError("The checkpoint and replacement journals do not match")


def review(root, reader, target, bundle, journal):
    target = HOST.PLAN.require_installation_protocol(target)
    if HOST.PLAN.read_version(root) != target["runtipiCompatibility"].removeprefix("v"):
        raise ReplacementError("The installed Runtipi version needs a separate compatibility review")
    if (root / "orbis-compose.yml").exists() or HOST.saved_state(root) is not None:
        raise ReplacementError("Use the Orbis updater for an already adopted installation")
    UPDATE.verify_release(target)
    Engine(reader)
    image = COMPAT.image_ledger(reader, target)
    checkpoint = TX.review(root, reader, bundle, checkpoint_path(journal))
    journal = TX.private_paths(root, checkpoint["storage"], journal)
    if journal.exists() or journal.is_symlink():
        raise ReplacementError("A replacement journal already exists; recover it instead")
    controller = next(key for key, item in checkpoint["roles"].items() if item == "controller")
    current = inspect(reader, controller)
    if current["Config"]["Image"] != "ghcr.io/runtipi/runtipi:v4.10.1" or current["Name"] != "/runtipi" or current["HostConfig"].get("ContainerIDFile"):
        raise ReplacementError("The original controller requires a separate configuration review")
    # Validate persistent Compose intent as well as the actual running container.
    planned = HOST.PLAN.plan(root, target)
    if planned["configuredImage"] != current["Config"]["Image"]:
        raise ReplacementError("The running and configured controller images differ")
    value = {
        "schema": SCHEMA, "mode": "keep", "root": str(root), "dockerContext": reader.context,
        "journal": str(journal), "target": target, "image": image, "checkpoint": checkpoint,
        "files": files(root), "controllerName": current["Name"].removeprefix("/"),
        "controllerConfiguration": APPS.digest({key: current[key] for key in ("Config", "HostConfig")}),
    }
    value["database"] = COMPAT.database(reader, role(value, "database"))
    COMPAT.require_compatible(value["database"]["ledger"], image["ledger"])
    COMPAT.idle_app_queue(reader, role(value, "queue"), stopped_controller=False)
    value["reviewId"] = APPS.digest(value)
    validate_review(value)
    if files(root) != value["files"]:
        raise ReplacementError("Installation files changed while replacement was reviewed")
    return value


def save(record):
    APPS.write_journal(Path(record["review"]["journal"]), record)


def original(record, reader):
    value = record["review"]
    raw = inspect(reader, role(value, "controller"))
    if APPS.digest({key: raw[key] for key in ("Config", "HostConfig")}) != record["quiescedConfiguration"]:
        raise ReplacementError("The retained controller configuration changed")
    if raw["State"]["Status"] not in {"exited", "created"} or raw["HostConfig"]["RestartPolicy"] != TX.NO_RESTART:
        raise ReplacementError("Keep the retained original controller stopped with automatic restarts disabled")
    if raw["Name"].removeprefix("/") not in {value["controllerName"], record["retainedName"]}:
        raise ReplacementError("The retained original controller was renamed outside this transaction")
    return raw


def payload(record, reader, phase):
    raw = original(record, reader)
    value = record["review"]
    body = copy.deepcopy(raw["Config"])
    prior = reader._object(["image", "inspect", "--format", "{{json .Config}}", raw["Image"]])
    incoming = reader._object(["image", "inspect", "--format", "{{json .Config}}", target_image(value["target"])])
    for key in ("Cmd", "Entrypoint", "User", "WorkingDir", "Healthcheck", "StopSignal", "StopTimeout", "Shell"):
        if body.get(key) == prior.get(key):
            if key in incoming:
                body[key] = incoming[key]
            else:
                body.pop(key, None)
    body["Image"] = target_image(value["target"])
    environment = dict(item.split("=", 1) for item in incoming.get("Env", []) if "=" in item)
    previous_environment = dict(item.split("=", 1) for item in prior.get("Env", []) if "=" in item)
    for entry in body.get("Env", []):
        key, separator, item = entry.partition("=")
        if separator and (key not in previous_environment or previous_environment[key] != item):
            environment[key] = item
    for key in list(environment):
        if key.startswith("ORBIS_"):
            del environment[key]
    environment.update(ORBIS_VERSION=value["target"]["tag"], ORBIS_COMMIT=value["target"]["commit"], ORBIS_IMAGE_DIGEST=value["target"]["digest"])
    if phase != "normal":
        environment.update(ORBIS_INSTALLER_PHASE=phase, ORBIS_INSTALLER_TRANSACTION=record["id"])
    body["Env"] = [key + "=" + item for key, item in sorted(environment.items())]
    labels = dict(incoming.get("Labels") or {})
    for key, item in (body.get("Labels") or {}).items():
        if key not in (prior.get("Labels") or {}) or prior["Labels"][key] != item:
            labels[key] = item
    labels.update({"io.orbis.installation.transaction": record["id"], "io.orbis.installation.phase": phase})
    body["Labels"] = labels
    host = copy.deepcopy(raw["HostConfig"])
    host["RestartPolicy"] = dict(TX.NO_RESTART)
    if host.get("OomKillDisable") is None:
        host["OomKillDisable"] = False
    if phase != "normal":
        host["PortBindings"] = {}
        host["PublishAllPorts"] = False
    body["HostConfig"] = host
    endpoints = {}
    for name, network in raw["NetworkSettings"]["Networks"].items():
        current = reader._object(["network", "inspect", "--format", '{"id":{{json .Id}}}', name])
        if current["id"] != network["NetworkID"]:
            raise ReplacementError("A controller network changed since the checkpoint")
        endpoints[name] = {key: network[key] for key in ("IPAMConfig", "Aliases", "Links", "DriverOpts", "GwPriority") if key in network and network[key] is not None}
    body["NetworkingConfig"] = {"EndpointsConfig": endpoints}
    return body


def canonical_host(value):
    value = copy.deepcopy(value)
    # Engine reports its default as false on create and null after start on
    # cgroup v2. An explicit true remains distinct and must never be accepted.
    if value.get("OomKillDisable") is None:
        value["OomKillDisable"] = False
    return value


def candidate_definition(raw):
    value = {key: copy.deepcopy(raw[key]) for key in ("Config", "HostConfig")}
    value["HostConfig"] = canonical_host(value["HostConfig"])
    value["HostConfig"].pop("RestartPolicy", None)
    value["networks"] = {name: {key: network.get(key) for key in ("IPAMConfig", "Aliases", "Links", "DriverOpts", "GwPriority")} for name, network in raw.get("NetworkSettings", {}).get("Networks", {}).items()}
    return APPS.digest(value)


def matches_intent(record, reader, raw):
    intended = payload(record, reader, record["candidatePhase"])
    for key, item in intended.items():
        if key in {"HostConfig", "NetworkingConfig"}:
            continue
        actual = raw["Config"].get(key)
        if key == "Env":
            actual, item = sorted(actual or []), sorted(item or [])
        if actual != item:
            raise ReplacementError("A newly created controller differs from its recorded configuration intent")
    if canonical_host(raw["HostConfig"]) != canonical_host(intended["HostConfig"]):
        raise ReplacementError("A newly created controller differs from its reviewed host settings")
    networks = raw.get("NetworkSettings", {}).get("Networks", {})
    if set(networks) != set(intended["NetworkingConfig"]["EndpointsConfig"]):
        raise ReplacementError("A newly created controller has different network attachments")
    for name, expected in intended["NetworkingConfig"]["EndpointsConfig"].items():
        for key, item in expected.items():
            if networks[name].get(key) != item:
                raise ReplacementError("A newly created controller has different network settings")


def candidate(record, reader):
    value = record["review"]
    rows = reader.containers()
    selected = [row for row in rows if row["name"] == value["controllerName"] and row["id"] != role(value, "controller")]
    if not selected:
        return None
    if len(selected) != 1:
        raise ReplacementError("The replacement controller name is ambiguous")
    raw = inspect(reader, selected[0]["id"])
    labels = raw["Config"].get("Labels") or {}
    if (
        labels.get("io.orbis.installation.transaction") != record["id"]
        or labels.get("io.orbis.installation.phase") != record.get("candidatePhase")
        or raw["Config"]["Image"] != target_image(value["target"]) or raw["Image"] != value["image"]["imageId"]
    ):
        raise ReplacementError("The replacement container differs from this transaction")
    known = record.get("candidate")
    if known and (known["id"] != raw["Id"] or known["definition"] != candidate_definition(raw)):
        raise ReplacementError("The replacement controller definition changed")
    expected_policy = next(item["restartPolicy"] for item in value["checkpoint"]["storage"]["containerStates"] if item["id"] == role(value, "controller"))
    if raw["HostConfig"]["RestartPolicy"] not in [TX.NO_RESTART, expected_policy] or (record["candidatePhase"] != "normal" and raw["HostConfig"]["RestartPolicy"] != TX.NO_RESTART):
        raise ReplacementError("The replacement restart policy changed outside this transaction")
    if not known and raw["Id"] != record.get("createdId"):
        matches_intent(record, reader, raw)
    expected_networks = record.get("networks")
    if expected_networks is None:
        expected_networks = {name: network["NetworkID"] for name, network in original(record, reader)["NetworkSettings"]["Networks"].items()}
    networks = raw.get("NetworkSettings", {}).get("Networks", {})
    if set(networks) != set(expected_networks) or any(network.get("NetworkID") != expected_networks[name] and not (raw["State"]["Status"] == "created" and not network.get("NetworkID")) for name, network in networks.items()):
        raise ReplacementError("The replacement controller network identity changed")
    return raw


def remove_candidate(record, reader):
    raw = candidate(record, reader)
    if raw is not None:
        reader.change(["update", "--restart", "no", raw["Id"]])
        if raw["State"]["Status"] == "running":
            reader.change(["stop", raw["Id"]], timeout=180)
        reader.change(["rm", raw["Id"]])
    record.pop("candidate", None)
    record.pop("createdId", None)
    save(record)


def create_candidate(record, reader, phase):
    if candidate(record, reader) is not None:
        raise ReplacementError("Remove the previous candidate before changing installation phase")
    record["candidatePhase"] = phase
    record.pop("candidate", None)
    save(record)
    body = payload(record, reader, phase)
    record["networks"] = {name: network["NetworkID"] for name, network in original(record, reader)["NetworkSettings"]["Networks"].items()}
    save(record)
    identifier = Engine(reader).create(record["review"]["controllerName"], body)
    record["createdId"] = identifier
    save(record)
    raw = candidate(record, reader)
    if raw is None or raw["Id"] != identifier:
        raise ReplacementError("The replacement controller could not be identified after creation")
    record["candidate"] = {"id": identifier, "definition": candidate_definition(raw), "validated": False}
    save(record)
    matches_intent(record, reader, raw)
    record["candidate"]["validated"] = True
    save(record)
    reader.change(["start", identifier], timeout=180)
    TX.require_healthy(reader, identifier, timeout=180)
    status = COMPAT.bounded_json(reader._read(["exec", identifier, "curl", "-fsS", "--max-time", "5", "http://127.0.0.1:3000/api/installation/status"]))
    if status.get("schema") != HOST.PLAN.INSTALLATION_PROTOCOL or status.get("phase") != phase or status.get("transactionId") != (None if phase == "normal" else record["id"]):
        raise ReplacementError("The replacement did not enter its recorded installation phase")
    return identifier


def check_originals(record, reader):
    value = record["review"]
    if APPS.digest_daemon(reader) != value["checkpoint"]["storage"]["daemonFingerprint"]:
        raise ReplacementError("The selected Docker daemon changed")
    rows = {item["id"]: item for item in reader.containers()}
    for expected in value["checkpoint"]["storage"]["containerStates"]:
        if expected["id"] == role(value, "controller"):
            continue
        row = rows.get(expected["id"])
        if row is None:
            raise ReplacementError("An original app or core service was removed during replacement")
        actual, _ = TX.STORAGE.container_record(reader, row)
        if actual["definitionHash"] != expected["definitionHash"] or actual["restartPolicy"] not in [TX.NO_RESTART, expected["restartPolicy"]]:
            raise ReplacementError("An original app or core service changed during replacement")
        if expected["state"] != "running" and actual["state"] != expected["state"]:
            raise ReplacementError("An originally stopped app changed state during replacement")
    for item in value["checkpoint"]["storage"]["resources"]:
        if TX.STORAGE.source_identity(Path(item["source"])) != item:
            raise ReplacementError("An installation storage source changed identity")


def start_originals(record, reader, roles):
    value = record["review"]
    for expected in TX.ordered(value["checkpoint"], starting=True):
        if value["checkpoint"]["roles"][expected["id"]] not in roles or expected["state"] != "running":
            continue
        check_originals(record, reader)
        if reader.app(expected["id"])["state"] != "running":
            reader.change(["start", expected["id"]], timeout=180)


def wait_broker(record, reader):
    deadline = time.monotonic() + 90
    while True:
        check_originals(record, reader)
        try:
            reader._read(["exec", role(record["review"], "queue"), "rabbitmq-diagnostics", "-q", "ping"])
            return
        except APPS.DETECT.InspectionError:
            if time.monotonic() >= deadline:
                raise ReplacementError("The original message broker did not recover after its checkpoint")
            time.sleep(1)


def completed_checkpoint(record, reader):
    value = record["review"]
    path = Path(value["checkpoint"]["journal"])
    if not path.exists() or TX.read_record(path, Path(value["root"]), reader)["stage"] != "recovered":
        return False
    expected = {item["id"]: item for item in value["checkpoint"]["storage"]["containerStates"]}
    if TX.identities(Path(value["root"]), reader, value["checkpoint"]) != expected:
        raise ReplacementError("The previously recovered installation changed; review it locally")
    TX.require_healthy(reader, role(value, "controller"), timeout=180)
    record["stage"] = "rolled-back"
    save(record)
    return True


def rollback(record, reader):
    value = record["review"]
    if record["stage"] not in PRECOMMIT:
        raise ReplacementError("Public activation has begun; recover this transaction to finish the recorded cutover")
    if completed_checkpoint(record, reader):
        return {"schema": SCHEMA, "result": "original-runtipi-recovered", "journal": value["journal"]}
    record["stage"] = "rolling-back"
    save(record)
    check_originals(record, reader)
    remove_candidate(record, reader)
    raw = original(record, reader)
    if raw["Name"].removeprefix("/") != value["controllerName"]:
        reader.change(["rename", raw["Id"], value["controllerName"]])
    result = TX.recover(Path(value["root"]), reader, Path(value["checkpoint"]["journal"]), host_writers_stopped=True)
    record.update(stage="rolled-back", recovered=result)
    save(record)
    return {"schema": SCHEMA, "result": "original-runtipi-recovered", "journal": value["journal"]}


def finish(record, reader):
    value = record["review"]
    record["stage"] = "committing"
    save(record)
    check_originals(record, reader)
    # App ports become reachable when their containers start. Record forward
    # recovery before accepting any new application writes.
    start_originals(record, reader, {"database", "queue", "app"})
    raw = candidate(record, reader)
    if raw is None:
        create_candidate(record, reader, "normal")
    elif record["candidatePhase"] != "normal":
        remove_candidate(record, reader)
        create_candidate(record, reader, "normal")
    else:
        if not record.get("candidate"):
            record["candidate"] = {"id": raw["Id"], "definition": candidate_definition(raw), "validated": False}
            save(record)
        if not record["candidate"].get("validated"):
            matches_intent(record, reader, raw)
            record["candidate"]["validated"] = True
            save(record)
        if raw["State"]["Status"] != "running":
            reader.change(["start", raw["Id"]], timeout=180)
        TX.require_healthy(reader, raw["Id"], timeout=180)
    start_originals(record, reader, {"database", "queue", "app", "proxy"})
    # Enroll the persistent Compose image/build override, without installer flags.
    HOST.write_state(Path(value["root"]), HOST.installation_fingerprint(Path(value["root"]), value["target"], reader.context))
    for expected in TX.ordered(value["checkpoint"], starting=True):
        identifier = candidate(record, reader)["Id"] if value["checkpoint"]["roles"][expected["id"]] == "controller" else expected["id"]
        policy = expected["restartPolicy"]
        flag = policy["Name"] + (f":{policy['MaximumRetryCount']}" if policy["Name"] == "on-failure" else "")
        reader.change(["update", "--restart", flag, identifier])
        if identifier == record["candidate"]["id"]:
            raw = inspect(reader, identifier)
            record["candidate"]["definition"] = candidate_definition(raw)
            save(record)
    existing = {row["id"] for row in reader.containers()}
    if role(value, "controller") in existing:
        original(record, reader)
        reader.change(["rm", role(value, "controller")])
    check_originals(record, reader)
    raw = candidate(record, reader)
    TX.require_healthy(reader, raw["Id"], timeout=180)
    record["stage"] = "complete"
    save(record)
    return {"schema": SCHEMA, "result": "orbis-installed", "mode": "keep", "releaseTag": value["target"]["tag"], "journal": value["journal"], "backup": value["checkpoint"]["storage"]["bundle"]}


def apply(root, reader, value, *, host_writers_stopped):
    validate_review(value)
    if not host_writers_stopped:
        raise ReplacementError("Confirm native host and remote storage writers are stopped before replacement")
    fresh = review(root, reader, value["target"], Path(value["checkpoint"]["storage"]["bundle"]), Path(value["journal"]))
    if fresh != value:
        raise ReplacementError("The installation changed; review the replacement again")
    record = {"schema": SCHEMA, "id": str(uuid.uuid4()), "stage": "prepared", "review": value}
    record["retainedName"] = "orbis-previous-" + record["id"]
    save(record)
    try:
        record["stage"] = "checkpointing"
        save(record)
        TX.checkpoint(root, reader, value["checkpoint"], host_writers_stopped=True)
        raw = inspect(reader, role(value, "controller"))
        record.update(stage="checkpointed", quiescedConfiguration=APPS.digest({key: raw[key] for key in ("Config", "HostConfig")}))
        save(record)
        # Restart only infrastructure to inspect the now-quiescent database/broker.
        start_originals(record, reader, {"database", "queue"})
        TX.require_healthy(reader, role(value, "database"), timeout=180)
        wait_broker(record, reader)
        actual = COMPAT.database(reader, role(value, "database"))
        COMPAT.require_compatible(actual["ledger"], value["image"]["ledger"])
        COMPAT.idle_app_queue(reader, role(value, "queue"), stopped_controller=True)
        if files(root) != value["files"]:
            raise ReplacementError("Installation files changed before cutover")
        record["stage"] = "retaining-original"
        save(record)
        reader.change(["rename", role(value, "controller"), record["retainedName"]])
        HOST.STAGE.stage(root, value["target"])
        record["stage"] = "holding"
        save(record)
        create_candidate(record, reader, "hold")
        record["stage"] = "held"
        save(record)
        remove_candidate(record, reader)
        record["stage"] = "resuming"
        save(record)
        create_candidate(record, reader, "resume")
        record["stage"] = "resumed"
        save(record)
        return finish(record, reader)
    except Exception as error:
        record["failure"] = {
            "stage": record["stage"], "type": type(error).__name__,
            "message": str(error) if isinstance(error, (ReplacementError, COMPAT.CompatibilityError)) else "A replacement step could not finish",
        }
        save(record)
        if record["stage"] in PRECOMMIT:
            # The original container has not been renamed before this point.
            if "quiescedConfiguration" not in record:
                if Path(value["checkpoint"]["journal"]).exists():
                    TX.recover(root, reader, Path(value["checkpoint"]["journal"]), host_writers_stopped=True)
                record["stage"] = "rolled-back"
                save(record)
            else:
                rollback(record, reader)
            raise ReplacementError("Replacement failed; the original Runtipi installation was recovered") from error
        raise ReplacementError("Activation needs recovery to finish; preserve the journal and run recover") from error


def recover(root, reader, journal, *, host_writers_stopped):
    if not host_writers_stopped:
        raise ReplacementError("Confirm native host and remote storage writers are stopped before recovery")
    record = TX.RESTORE.private_json(journal)
    if record.get("schema") != SCHEMA or record.get("stage") not in PRECOMMIT | {"committing", *TERMINAL}:
        raise ReplacementError("The replacement journal is invalid")
    value = record["review"]
    validate_review(value)
    if value["root"] != str(root) or value["dockerContext"] != reader.context or value["journal"] != str(journal):
        raise ReplacementError("The journal belongs to another installation or Docker context")
    check_originals(record, reader)
    if record["stage"] in TERMINAL:
        raise ReplacementError("The replacement is already complete or recovered; it cannot be replayed")
    if record["stage"] == "committing":
        return finish(record, reader)
    if "quiescedConfiguration" not in record:
        if completed_checkpoint(record, reader):
            return {"schema": SCHEMA, "result": "original-runtipi-recovered", "journal": str(journal)}
        if Path(value["checkpoint"]["journal"]).exists():
            TX.recover(root, reader, Path(value["checkpoint"]["journal"]), host_writers_stopped=True)
        record["stage"] = "rolled-back"
        save(record)
        return {"schema": SCHEMA, "result": "original-runtipi-recovered", "journal": str(journal)}
    return rollback(record, reader)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("review", "apply", "recover"))
    parser.add_argument("root", type=Path)
    parser.add_argument("--docker-context", required=True)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--backup", type=Path)
    parser.add_argument("--journal", type=Path, required=True)
    parser.add_argument("--review", type=Path)
    parser.add_argument("--confirm-root")
    parser.add_argument("--host-writers-stopped", action="store_true")
    args = parser.parse_args()
    try:
        if sys.platform != "linux" or os.geteuid() != 0:
            raise ReplacementError("Run replacement as root on the Linux Docker host")
        root = args.root.expanduser().resolve(strict=True)
        reader = APPS.Docker(args.docker_context)
        journal = args.journal.expanduser()
        with HOST.host_lock(root) as descriptor:
            reader.lock_fd = descriptor
            if args.action == "review":
                if args.manifest is None or args.backup is None:
                    raise ReplacementError("A published release manifest and new private backup are required")
                result = review(root, reader, json.loads(args.manifest.read_text()), args.backup.expanduser(), journal)
            else:
                HOST.require_confirmation(root, args.confirm_root)
                if args.action == "recover":
                    result = recover(root, reader, journal, host_writers_stopped=args.host_writers_stopped)
                else:
                    if args.review is None:
                        raise ReplacementError("A private saved replacement review is required")
                    value = TX.RESTORE.private_json(args.review.expanduser())
                    if value.get("journal") != str(journal):
                        raise ReplacementError("The review belongs to another journal")
                    result = apply(root, reader, value, host_writers_stopped=args.host_writers_stopped)
        print(json.dumps(result, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        message = str(error) if isinstance(error, (ReplacementError, COMPAT.CompatibilityError)) else "Replacement could not finish; inspect the private journal before continuing"
        print(json.dumps({"schema": SCHEMA, "result": "replacement-failed", "message": message}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
