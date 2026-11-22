#!/usr/bin/env python3
"""Replace a reviewed Runtipi controller, retaining its data and rollback copy.

Run on the Linux Docker host. The original controller remains stopped until
the replacement passes hold/resume checks. Before public activation, recovery
rolls back; after activation begins, recovery finishes the recorded cutover.
"""

import argparse
import copy
from contextlib import contextmanager
from contextvars import ContextVar
import hashlib
import http.client
import importlib.util
import json
import os
import re
import socket
import subprocess
import sys
import time
from types import ModuleType
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
FRESH = load("orbis-install-fresh.py", "orbis_fresh_for_replacement")
UPDATE = load("orbis-host-update.py", "orbis_update_for_replacement")
OWNERSHIP = load("orbis-host-fresh-ownership.py", "orbis_fresh_ownership_for_replacement")
_FRESH_PERMIT = ContextVar('orbis_replacement_fresh_permit', default=None)
APPS = TX.APPS
HOST = APPS.HOST
SCHEMA = "orbis.installation-replacement.v1"
OWNERSHIP_PROTOCOL = 'orbis.fresh-ownership-entry.v1'
INSTALLER_STORAGE_PROTOCOL = 'orbis.installer.storage.v1'
TERMINAL = {"complete", "rolled-back"}
PRECOMMIT = {"prepared", "checkpointing", "checkpointed", "retaining-original", "holding", "held", "resetting", "reset", "resuming", "resumed", "rolling-back"}


class ReplacementError(ValueError):
    pass


@contextmanager
def ownership_scope(permit, record):
    """Bind only the exact Root issuer attached to this replacement module."""
    if (type(permit) is not OWNERSHIP.Permit or permit.issuer.runtime is None
            or permit.issuer.runtime.r._FRESH_PERMIT is not _FRESH_PERMIT
            or permit.issuer.host is not HOST):
        raise ReplacementError('The replacement requires its own live Root ownership issuer')
    permit._frame(record)
    token = _FRESH_PERMIT.set(permit)
    try:
        yield
    finally:
        _FRESH_PERMIT.reset(token)


def require_ownership_authority(mode, *, record=None):
    """Admit only Keep or the exact bound Root finishing transaction.

    A JWT/cache revocation receipt and an idle lifecycle lock do not prove
    recovery revocation. The existing Main credential lease also cannot cover
    replacing its producer. Review/apply/recovery acquire their own positive
    transaction scope. Neither missing admission nor a caller-supplied receipt
    may bypass this guard. Keep retains its existing ownership.
    """
    permit = _FRESH_PERMIT.get()
    if (mode == 'fresh' and record is not None and type(permit) is OWNERSHIP.Permit
            and permit.issuer.runtime.r._FRESH_PERMIT is _FRESH_PERMIT):
        permit.authorize_controller(record)
        return
    if mode != 'keep':
        raise ReplacementError('Fresh replacement requires a positively bound Root ownership permit; preserve the original installation, journal and checkpoint for local review')


def ownership_issuer(root, reader, guard):
    module = sys.modules.get(__name__)
    if module is None or getattr(module, 'validate_review', None) is not validate_review:
        module = ModuleType(__name__)
        module.__dict__.update(globals())
    issuer = OWNERSHIP.Issuer(HOST, root, reader, validate_review)
    try:
        issuer._guard(guard)
    except (AttributeError, ValueError, TypeError):
        raise ReplacementError('Fresh replacement requires its live Root ownership permit lock') from None
    issuer.attach_replacement(module)
    return issuer


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
    names = ["docker-compose.yml", ".env", "VERSION", "user-config/tipi-compose.yml", "orbis-compose.yml"]
    host_override = root / "orbis-host-compose.yml"
    if host_override.exists() or host_override.is_symlink():
        names.append(host_override.name)
    return {name: HOST.file_digest(root / name) for name in names}


def checkpoint_path(journal):
    return Path(str(journal) + ".checkpoint.json")


def validate_review(value):
    if not isinstance(value, dict) or value.get("schema") != SCHEMA or value.get("reviewId") != APPS.digest({key: item for key, item in value.items() if key != "reviewId"}):
        raise ReplacementError("The replacement review is invalid or was edited")
    TX.validate_review(value["checkpoint"])
    HOST.PLAN.require_installation_protocol(value["target"])
    COMPAT.require_compatible(value["database"]["ledger"], value["image"]["ledger"])
    if value["mode"] not in {"keep", "fresh"} or value["root"] != value["checkpoint"]["root"] or value["dockerContext"] != value["checkpoint"]["dockerContext"]:
        raise ReplacementError("The replacement review has an unsupported mode or installation")
    if value["mode"] == "fresh" and not isinstance(value.get("fresh"), dict):
        raise ReplacementError("The Fresh account reset has not been reviewed")
    if value["checkpoint"]["journal"] != str(checkpoint_path(value["journal"])):
        raise ReplacementError("The checkpoint and replacement journals do not match")


def semantic_review(value):
    return {key: TX.semantic_review(item) if key == "checkpoint" else item for key, item in value.items() if key != "reviewId"}


def review(root, reader, target, bundle, journal, *, mode="keep", backup_scope="full", ownership=None):
    if mode not in {"keep", "fresh"}:
        raise ReplacementError("Choose Keep or Fresh replacement")
    if mode == 'fresh' and ownership is not None:
        issuer = ownership_issuer(root, reader, ownership)
        if ownership.read() is not None:
            raise ReplacementError('Recover the pending Root ownership transaction before another review')
        with OWNERSHIP.L.authorized(HOST, root, reader, target) as proof:
            decision = proof.verify()
            value = _review(root, reader, target, bundle, journal, mode=mode, backup_scope=backup_scope)
            value['freshOwnership'] = decision
            value['ownershipProtocol'] = OWNERSHIP_PROTOCOL
            value['reviewId'] = APPS.digest({key: item for key, item in value.items() if key != 'reviewId'})
            validate_review(value)
            if proof.verify() != decision:
                raise ReplacementError('The Root ownership decision changed during review')
            return value
    require_ownership_authority(mode)
    return _review(root, reader, target, bundle, journal, mode=mode, backup_scope=backup_scope)


def _review(root, reader, target, bundle, journal, *, mode, backup_scope):
    target = HOST.PLAN.require_installation_protocol(target)
    if HOST.PLAN.read_version(root) != target["runtipiCompatibility"].removeprefix("v"):
        raise ReplacementError("The installed Runtipi version needs a separate compatibility review")
    if (root / "orbis-compose.yml").exists() or HOST.saved_state(root) is not None:
        raise ReplacementError("Use the Orbis updater for an already adopted installation")
    UPDATE.verify_release(target)
    Engine(reader)
    checkpoint = TX.review(root, reader, bundle, checkpoint_path(journal), scope=backup_scope)
    journal = TX.private_paths(root, checkpoint["storage"], journal)
    if journal.exists() or journal.is_symlink():
        raise ReplacementError("A replacement journal already exists; recover it instead")
    controller = next(key for key, item in checkpoint["roles"].items() if item == "controller")
    current = inspect(reader, controller)
    if current["Config"]["Image"] != "ghcr.io/runtipi/runtipi:v4.10.1" or current["Name"] != "/runtipi" or current["HostConfig"].get("ContainerIDFile"):
        raise ReplacementError("The original controller requires a separate configuration review")
    image = COMPAT.image_ledger(reader, target, logging_driver=current["HostConfig"]["LogConfig"]["Type"])
    # Validate persistent Compose intent as well as the actual running container.
    planned = HOST.PLAN.plan(root, target)
    if planned["configuredImage"] != current["Config"]["Image"]:
        raise ReplacementError("The running and configured controller images differ")
    value = {
        "schema": SCHEMA, "mode": mode, "root": str(root), "dockerContext": reader.context,
        "journal": str(journal), "target": target, "image": image, "checkpoint": checkpoint,
        "files": files(root), "controllerName": current["Name"].removeprefix("/"),
        "controllerConfiguration": APPS.digest({key: current[key] for key in ("Config", "HostConfig")}),
    }
    value["database"] = COMPAT.database(reader, role(value, "database"))
    COMPAT.require_compatible(value["database"]["ledger"], image["ledger"])
    COMPAT.idle_app_queue(reader, role(value, "queue"), stopped_controller=False)
    if mode == "fresh":
        value["fresh"] = FRESH.review(root, reader, current, role(value, "database"))
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


def require_fresh_revocation(record):
    value = record['review']
    if value.get('mode') != 'fresh':
        return
    permit = _FRESH_PERMIT.get()
    if permit is not None:
        if type(permit) is not OWNERSHIP.Permit or permit.issuer.runtime.r._FRESH_PERMIT is not _FRESH_PERMIT:
            raise ReplacementError('The replacement ownership issuer changed')
        permit.authorize_controller(record)
        return
    receipt = record.get('freshReset')
    if (type(receipt) is not dict or receipt.get('cacheRevoked') is not True or receipt.get('passkeysRevoked') is not True
            or type(receipt.get('jwtHash')) is not str or not re.fullmatch(r'[0-9a-f]{64}', receipt['jwtHash'])
            or type(receipt.get('authenticationSha256')) is not str or not re.fullmatch(r'[0-9a-f]{64}', receipt['authenticationSha256'])
            or type(value.get('fresh')) is not dict or receipt.get('reviewSha256') != FRESH.review_digest(value['fresh'])):
        raise ReplacementError('Fresh account revocation must finish under the current review before activation; keep the installation stopped and preserve its journal and backup')
    # Once a validated normal candidate can receive new account writes, forward
    # recovery must preserve them instead of demanding the pre-activation empty
    # key store. The protected candidate definition is checked by the caller.
    if (record.get('stage') == 'committing' and record.get('candidatePhase') == 'normal'
            and type(record.get('candidate')) is dict and record['candidate'].get('validated') is True):
        return
    try:
        current = FRESH.authentication(Path(value['root']))
        if current['passkeys'] is not None or receipt.get('authenticationSha256') != FRESH.review_digest(current):
            raise FRESH.FreshError('Authentication state changed after revocation')
    except (FRESH.FreshError, KeyError, TypeError):
        raise ReplacementError('Fresh authentication revocation needs recovery; keep the installation stopped and preserve its journal and backup') from None


def payload(record, reader, phase):
    if phase != 'hold' or 'freshReset' in record:
        require_fresh_revocation(record)
    return _controller_payload(record, reader, phase)


def _controller_payload(record, reader, phase):
    """Build creation intent; public callers use the guarded payload wrapper."""
    if phase not in ('hold', 'resume', 'normal'):
        raise ReplacementError('The replacement controller phase is unsupported')
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
    if value.get("mode") == "fresh" and record.get("freshReset"):
        key = FRESH.secret(Path(value["root"]))
        if FRESH.key_hash(key) != record["freshReset"]["jwtHash"]:
            raise ReplacementError("The Fresh signing key changed after its reset")
        environment["JWT_SECRET"] = key
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
    _matches_body(record, raw, intended)


def _matches_body(record, raw, intended):
    for key, item in intended.items():
        if key in {"HostConfig", "NetworkingConfig"}:
            continue
        actual = raw["Config"].get(key)
        if key == "Env":
            actual, item = sorted(actual or []), sorted(item or [])
        if actual != item:
            raise ReplacementError("A newly created controller differs from its recorded configuration intent")
    actual_host, intended_host = canonical_host(raw["HostConfig"]), canonical_host(intended["HostConfig"])
    defaults = record["review"]["image"].get("loggingDefaults")
    if defaults is not None:
        actual_log, intended_log = actual_host.get("LogConfig", {}), intended_host.get("LogConfig", {})
        actual_options, intended_options = actual_log.get("Config") or {}, intended_log.get("Config") or {}
        inherited = defaults["options"]
        # Docker merges daemon logging defaults into a new container. Verify them
        # against the isolated image probe, while retaining every explicit override.
        if (
            actual_log.get("Type") != intended_log.get("Type") or defaults["driver"] != intended_log.get("Type")
            or set(actual_options) != set(inherited) | set(intended_options)
            or any(actual_options.get(key) != item for key, item in intended_options.items())
            or any(hashlib.sha256(actual_options[key].encode()).hexdigest() != item for key, item in inherited.items() if key not in intended_options)
        ):
            raise ReplacementError("A newly created controller differs from its reviewed host settings: LogConfig")
        intended_host["LogConfig"] = copy.deepcopy(actual_log)
    different = sorted(key for key in actual_host.keys() | intended_host.keys() if actual_host.get(key) != intended_host.get(key))
    if different:
        raise ReplacementError("A newly created controller differs from its reviewed host settings: " + ", ".join(different))
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
    if phase != 'hold' or 'freshReset' in record:
        require_fresh_revocation(record)
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


def check_original_containers(record, reader):
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


def check_original_resources(record, reader):
    for item in record["review"]["checkpoint"]["storage"]["resources"]:
        if TX.STORAGE.resource_identity(item) != item:
            raise ReplacementError("An installation storage source changed identity")


def check_originals(record, reader):
    permit = _FRESH_PERMIT.get()
    if record['review'].get('mode') == 'fresh' and permit is not None:
        if type(permit) is not OWNERSHIP.Permit or permit.issuer.reader is not reader:
            raise ReplacementError('The replacement ownership reader changed')
        permit.authorize_originals(record)
        return
    check_original_containers(record, reader)
    check_original_resources(record, reader)


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
    permit = _FRESH_PERMIT.get()
    if value.get('mode') == 'fresh' and permit is not None:
        if type(permit) is not OWNERSHIP.Permit or permit.issuer.reader is not reader:
            raise ReplacementError('The replacement rollback issuer changed')
        permit.rollback(record)
        return {"schema": SCHEMA, "result": "original-runtipi-recovered", "journal": value['journal']}
    # A stage label alone cannot authorize restoring an enrolled installation.
    require_ownership_authority(value.get('mode'))
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
    if record['stage'] in TERMINAL:
        raise ReplacementError('The replacement is already complete or recovered; it cannot be replayed')
    value = record["review"]
    require_ownership_authority(value.get('mode'), record=record)
    require_fresh_revocation(record)
    permit = _FRESH_PERMIT.get() if value.get('mode') == 'fresh' else None
    if permit is not None:
        permit.record_forward(record)
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
    if permit is not None:
        permit.record_normal(record)
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
    if permit is not None:
        permit.complete(record)
    return {"schema": SCHEMA, "result": "orbis-installed", "mode": value["mode"], "releaseTag": value["target"]["tag"], "journal": value["journal"], "backup": value["checkpoint"]["storage"]["bundle"]}


def apply(root, reader, value, *, host_writers_stopped, ownership=None):
    validate_review(value)
    if value.get('mode') == 'fresh' and ownership is not None:
        issuer = ownership_issuer(root, reader, ownership)
        if not host_writers_stopped or value.get('ownershipProtocol') != OWNERSHIP_PROTOCOL:
            raise ReplacementError('Fresh requires the current protected review and stopped native writers')
        current = review(root, reader, value['target'], Path(value['checkpoint']['storage']['bundle']),
                         Path(value['journal']), mode='fresh', backup_scope=value['checkpoint']['storage'].get('backupScope', 'full'), ownership=ownership)
        if semantic_review(current) != semantic_review(value):
            raise ReplacementError('The installation changed; review Fresh again')
        record = {'schema': SCHEMA, 'id': str(uuid.uuid4()), 'stage': 'prepared', 'review': value,
                  'ownershipProtocol': OWNERSHIP_PROTOCOL}
        record['retainedName'] = 'orbis-previous-' + record['id']
        with issuer.begin(ownership, value, record['id']) as permit:
            record['ownershipPermit'] = permit.reference
            with ownership_scope(permit, record):
                return _apply_record(record, reader, permit=permit)
    require_ownership_authority(value.get('mode'))
    if not host_writers_stopped:
        raise ReplacementError("Confirm native host and remote storage writers are stopped before replacement")
    fresh = review(root, reader, value["target"], Path(value["checkpoint"]["storage"]["bundle"]), Path(value["journal"]), mode=value["mode"], backup_scope=value["checkpoint"]["storage"].get("backupScope", "full"))
    if semantic_review(fresh) != semantic_review(value):
        raise ReplacementError("The installation changed; review the replacement again")
    record = {"schema": SCHEMA, "id": str(uuid.uuid4()), "stage": "prepared", "review": value}
    record["retainedName"] = "orbis-previous-" + record["id"]
    save(record)
    return _apply_record(record, reader)


def _apply_record(record, reader, *, permit=None):
    value = record['review']
    root = Path(value['root'])
    try:
        if permit is not None:
            save(record)
        record["stage"] = "checkpointing"
        save(record)
        TX.checkpoint(root, reader, value["checkpoint"], host_writers_stopped=True)
        raw = inspect(reader, role(value, "controller"))
        record.update(stage="checkpointed", quiescedConfiguration=APPS.digest({key: raw[key] for key in ("Config", "HostConfig")}))
        save(record)
        if permit is not None:
            permit.record_cutover(record)
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
        if permit is not None:
            permit.record_hold(record)
        remove_candidate(record, reader)
        if value["mode"] == "fresh":
            record["stage"] = "resetting"
            save(record)
            check_originals(record, reader)
            for identifier, selected_role in value["checkpoint"]["roles"].items():
                if selected_role not in {"database", "queue"} and reader.app(identifier)["state"] not in {"exited", "created"}:
                    raise ReplacementError("Keep every controller, proxy and app stopped during Fresh account reset")
            record["freshReset"] = permit.reset_accounts(record) if permit is not None else FRESH.reset(root, reader, role(value, "database"), value["fresh"])
            record["stage"] = "reset"
            save(record)
            if permit is not None:
                permit.publish_birth(record)
        record["stage"] = "resuming"
        save(record)
        if permit is not None:
            permit.arm_resume(record)
        create_candidate(record, reader, "resume")
        record["stage"] = "resumed"
        save(record)
        return finish(record, reader)
    except Exception as error:
        if permit is not None:
            selected = permit.reference
            def exists(name):
                return os.path.lexists(OWNERSHIP.phase_path(root, selected['operationId'], name, HOST))
            if any(exists(name) for name in ('complete', 'rolled-back', 'aborted', 'forward', 'normal')):
                # A published outcome pins the final journal; a lost retirement
                # reply must not overwrite it with generic failure metadata.
                raise ReplacementError('The protected transaction needs recovery to settle its recorded outcome; preserve the journal') from error
            try:
                if exists('cutover') or exists('rollback'):
                    permit.rollback(record)
                else:
                    permit.abort_pre_cutover(record)
            except Exception as recovery:
                raise ReplacementError('Fresh needs protected recovery; preserve the original, journal, checkpoint and Root receipts') from recovery
            raise ReplacementError('Replacement failed; the original Runtipi installation was recovered') from error
        record["failure"] = {
            "stage": record["stage"], "type": type(error).__name__,
            "message": str(error) if isinstance(error, (ReplacementError, COMPAT.CompatibilityError, FRESH.FreshError, TX.TransactionError, TX.STORAGE.StorageError)) else "A replacement step could not finish",
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


def installed_result(record):
    value = record['review']
    return {'schema': SCHEMA, 'result': 'orbis-installed', 'mode': value['mode'], 'releaseTag': value['target']['tag'],
            'journal': value['journal'], 'backup': value['checkpoint']['storage']['bundle']}


def recover_owned(root, reader, record, guard):
    issuer = ownership_issuer(root, reader, guard)
    if (record.get('ownershipProtocol') != OWNERSHIP_PROTOCOL or record['review'].get('ownershipProtocol') != OWNERSHIP_PROTOCOL):
        raise ReplacementError('Fresh recovery requires the original compatible protected executor')
    selected = OWNERSHIP.reference(record.get('ownershipPermit'))
    def exists(name):
        return os.path.lexists(OWNERSHIP.phase_path(root, selected['operationId'], name, HOST))
    if exists('complete'):
        with issuer.resume_completed(guard, record, selected) as permit:
            permit.complete(record)
        return installed_result(record)
    if exists('rolled-back'):
        with issuer.resume_rollback(guard, record, selected) as permit:
            permit.rollback(record)
        return {'schema': SCHEMA, 'result': 'original-runtipi-recovered', 'journal': record['review']['journal']}
    if exists('aborted'):
        with issuer.resume_abort(guard, record, selected) as permit:
            permit.abort_pre_cutover(record)
        return {'schema': SCHEMA, 'result': 'original-runtipi-recovered', 'journal': record['review']['journal']}
    with issuer.transaction(guard, record, selected) as permit:
        with ownership_scope(permit, record):
            if exists('forward') or exists('normal'):
                if record.get('stage') == 'complete':
                    permit.complete(record)
                    return installed_result(record)
                return finish(record, reader)
            if exists('cutover') or exists('rollback'):
                return rollback(record, reader)
            permit.abort_pre_cutover(record)
            return {'schema': SCHEMA, 'result': 'original-runtipi-recovered', 'journal': record['review']['journal']}


def recover(root, reader, journal, *, host_writers_stopped, ownership=None):
    if not host_writers_stopped:
        raise ReplacementError("Confirm native host and remote storage writers are stopped before recovery")
    record = TX.RESTORE.private_json(journal)
    if record.get("schema") != SCHEMA or record.get("stage") not in PRECOMMIT | {"committing", *TERMINAL}:
        raise ReplacementError("The replacement journal is invalid")
    value = record["review"]
    validate_review(value)
    if value["root"] != str(root) or value["dockerContext"] != reader.context or value["journal"] != str(journal):
        raise ReplacementError("The journal belongs to another installation or Docker context")
    if value.get('mode') == 'fresh' and ownership is not None:
        return recover_owned(root, reader, record, ownership)
    if record["stage"] in TERMINAL:
        raise ReplacementError("The replacement is already complete or recovered; it cannot be replayed")
    require_ownership_authority(value.get('mode'))
    if value.get('mode') == 'fresh' and ('freshReset' in record or record['stage'] in {'reset', 'resuming', 'resumed', 'committing'}):
        require_fresh_revocation(record)
    check_originals(record, reader)
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


def require_host():
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise ReplacementError('Run replacement as root on the Linux Docker host')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("review", "apply", "recover"))
    parser.add_argument("root", type=Path)
    parser.add_argument("--docker-context", required=True)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--backup", type=Path)
    parser.add_argument("--journal", type=Path, required=True)
    parser.add_argument("--review", type=Path)
    parser.add_argument("--mode", choices=("keep", "fresh"))
    parser.add_argument("--backup-scope", choices=("controller", "full"), default="full")
    parser.add_argument("--confirm-root")
    parser.add_argument("--host-writers-stopped", action="store_true")
    args = parser.parse_args()
    try:
        require_host()
        root = args.root.expanduser().resolve(strict=True)
        reader = APPS.Docker(args.docker_context)
        journal = args.journal.expanduser()
        with HOST.credential_fence_lock(root, reader.context) as guard:
            reader.lock_fd = HOST.LOCK_DESCRIPTOR.get()
            if args.action == "review":
                if args.manifest is None or args.backup is None:
                    raise ReplacementError("A published release manifest and new private backup are required")
                if args.mode != 'fresh' and guard.read() is not None:
                    raise ReplacementError('A protected account transaction needs recovery first')
                result = review(root, reader, json.loads(args.manifest.read_text()), args.backup.expanduser(), journal, mode=args.mode or "keep", backup_scope=args.backup_scope, ownership=guard)
            else:
                HOST.require_confirmation(root, args.confirm_root)
                if args.action == "recover":
                    pending = TX.RESTORE.private_json(journal)
                    if pending.get('review', {}).get('mode') != 'fresh' and guard.read() is not None:
                        raise ReplacementError('A protected account transaction needs recovery first')
                    result = recover(root, reader, journal, host_writers_stopped=args.host_writers_stopped, ownership=guard)
                else:
                    if args.review is None:
                        raise ReplacementError("A private saved replacement review is required")
                    value = TX.RESTORE.private_json(args.review.expanduser())
                    if args.mode is not None and args.mode != value.get("mode"):
                        raise ReplacementError("The requested mode differs from the saved replacement review")
                    if value.get("journal") != str(journal):
                        raise ReplacementError("The review belongs to another journal")
                    if value.get('mode') != 'fresh' and guard.read() is not None:
                        raise ReplacementError('A protected account transaction needs recovery first')
                    result = apply(root, reader, value, host_writers_stopped=args.host_writers_stopped, ownership=guard)
        print(json.dumps(result, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        message = str(error) if isinstance(error, (ReplacementError, COMPAT.CompatibilityError, FRESH.FreshError, TX.TransactionError, TX.STORAGE.StorageError)) else "Replacement could not finish; inspect the private journal before continuing"
        print(json.dumps({"schema": SCHEMA, "result": "replacement-failed", "message": message}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
