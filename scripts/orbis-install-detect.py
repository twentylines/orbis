#!/usr/bin/env python3
"""Discover Runtipi and Orbis installations on an explicitly selected Docker host.

Only Docker metadata is read. No host files, environment values, images or
containers are changed. A discovered installation still needs a migration plan.
"""

import argparse
import hashlib
import json
import posixpath
import re
import subprocess
import sys


SCHEMA = "orbis.installation-discovery.v1"
CORE_SERVICES = {"runtipi", "runtipi-db", "runtipi-queue", "runtipi-reverse-proxy"}
CORE_PORTS = {80, 443, 8080}
DATA_MOUNTS = {
    "/app-data", "/data/app-data", "/data/apps", "/data/state", "/data/media",
    "/data/repos", "/data/backups", "/data/user-config", "/data/traefik", "/data/logs",
}
IMAGE_BASES = {"ghcr.io/runtipi/runtipi": "runtipi", "ghcr.io/twentylines/orbis": "orbis"}
IDENTIFIER = re.compile(r"^[0-9a-f]{64}$")
CONTEXT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
VERSION = re.compile(r"^v?\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$")
LIST_FORMAT = (
    '{"id":{{json .ID}},"name":{{json .Names}},"image":{{json .Image}},'
    '"project":{{json (.Label "com.docker.compose.project")}},'
    '"service":{{json (.Label "com.docker.compose.service")}},'
    '"workingDir":{{json (.Label "com.docker.compose.project.working_dir")}},'
    '"configFiles":{{json (.Label "com.docker.compose.project.config_files")}},'
    '"managed":{{json (.Label "runtipi.managed")}},"appUrn":{{json (.Label "runtipi.appurn")}},'
    '"state":{{json .State}},"publishedPorts":{{json .Ports}}}'
)
CORE_FORMAT = '{"id":{{json .Id}},"imageId":{{json .Image}},"mounts":{{json .Mounts}}}'
IMAGE_FORMAT = '{"version":{{json (index .Config.Labels "org.opencontainers.image.version")}}}'
PORT_FORMAT = '{"bindings":{{json .NetworkSettings.Ports}}}'


class InspectionError(RuntimeError):
    pass


def text(value: object, limit: int = 4096) -> str:
    if not isinstance(value, str) or len(value) > limit or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise InspectionError("Docker returned invalid installation metadata")
    return value


def path(value: object) -> str | None:
    if value in (None, ""):
        return None
    value = text(value)
    if not value.startswith("/") or value.startswith("//"):
        return None
    normalized = posixpath.normpath(value)
    return normalized if normalized != "/" else None


def beneath(value: str, root: str) -> bool:
    return value == root or value.startswith(root + "/")


def image_brand(reference: object) -> str | None:
    reference = text(reference)
    base = reference.split("@", 1)[0].split(":", 1)[0]
    return IMAGE_BASES.get(base)


class DockerReader:
    def __init__(self, context: str):
        if not CONTEXT.fullmatch(context):
            raise ValueError("Docker context name is invalid")
        self.context = context

    def _read(self, arguments: list[str]) -> str:
        try:
            result = subprocess.run(
                ["docker", "--context", self.context, *arguments],
                text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                timeout=20, check=False,
            )
        except (OSError, UnicodeError, subprocess.TimeoutExpired) as error:
            raise InspectionError("Docker could not be inspected; check the selected context and permissions") from error
        if result.returncode or len(result.stdout) > 8 * 1024 * 1024:
            raise InspectionError("Docker could not be inspected; check the selected context and permissions")
        return result.stdout.strip()

    def _object(self, arguments: list[str]) -> dict:
        try:
            result = json.loads(self._read(arguments))
        except (json.JSONDecodeError, UnicodeError) as error:
            raise InspectionError("Docker returned invalid inspection data") from error
        if not isinstance(result, dict):
            raise InspectionError("Docker returned invalid inspection data")
        return result

    def daemon(self) -> str:
        value = self._read(["info", "--format", "{{.ID}}"])
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9:_.-]{0,255}", value):
            raise InspectionError("Docker returned an invalid daemon identity")
        return value

    def socket(self) -> str | None:
        endpoint = self._object(["context", "inspect", self.context, "--format", '{"host":{{json .Endpoints.docker.Host}}}']).get("host")
        if not isinstance(endpoint, str) or not endpoint.startswith("unix://"):
            return None
        return path(endpoint.removeprefix("unix://"))

    def containers(self) -> list[dict]:
        try:
            rows = [json.loads(line) for line in self._read(["container", "ls", "--all", "--no-trunc", "--format", LIST_FORMAT]).splitlines()]
        except (json.JSONDecodeError, UnicodeError) as error:
            raise InspectionError("Docker returned invalid container inventory") from error
        if len(rows) > 4096:
            raise InspectionError("Docker container inventory exceeds the discovery limit")
        return rows

    def core(self, identifier: str) -> dict:
        return self._object(["container", "inspect", "--format", CORE_FORMAT, identifier])

    def image(self, identifier: str) -> dict:
        return self._object(["image", "inspect", "--format", IMAGE_FORMAT, identifier])

    def ports(self, identifier: str) -> dict:
        return self._object(["container", "inspect", "--format", PORT_FORMAT, identifier])


def validate_rows(rows: list[dict]) -> None:
    identifiers = set()
    names = set()
    for row in rows:
        if not isinstance(row, dict):
            raise InspectionError("Docker returned invalid container inventory")
        for key in ("id", "name", "image", "project", "service", "workingDir", "state", "publishedPorts", "managed", "appUrn"):
            text(row.get(key))
        text(row.get("configFiles", ""))
        if not IDENTIFIER.fullmatch(row["id"]) or row["id"] in identifiers or not row["name"] or row["name"] in names:
            raise InspectionError("Docker returned duplicate or invalid container identities")
        identifiers.add(row["id"])
        names.add(row["name"])


def validate_mounts(mounts: object) -> list[dict]:
    if not isinstance(mounts, list) or len(mounts) > 512:
        raise InspectionError("Docker returned invalid installation mounts")
    destinations = set()
    for mount in mounts:
        if not isinstance(mount, dict):
            raise InspectionError("Docker returned invalid installation mounts")
        destination = path(mount.get("Destination"))
        if destination is None or destination in destinations:
            raise InspectionError("Docker returned invalid or duplicate mount destinations")
        destinations.add(destination)
    return mounts


def storage_mounts(mounts: list[dict], root: str | None, app: bool = False) -> list[dict]:
    storage = []
    for mount in mounts:
        destination = path(mount["Destination"])
        if not app and destination not in DATA_MOUNTS:
            continue
        kind = text(mount.get("Type"), 32)
        entry = {"destination": destination, "type": kind}
        if kind == "bind":
            source = path(mount.get("Source"))
            if source is None:
                raise InspectionError("Docker returned invalid installation storage")
            entry["source"] = source
        elif kind == "volume":
            name = text(mount.get("Name"), 255)
            if not name:
                raise InspectionError("Docker returned an unnamed installation volume")
            entry["volume"] = name
        elif kind == "tmpfs":
            entry["volatile"] = True
        else:
            raise InspectionError("Docker returned unsupported installation storage")
        writable = mount.get("RW")
        if writable is not None and not isinstance(writable, bool):
            raise InspectionError("Docker returned invalid mount permissions")
        entry["readOnly"] = not writable if writable is not None else None
        entry["external"] = kind != "bind" or not root or not beneath(entry["source"], root)
        storage.append(entry)
    return sorted(storage, key=lambda entry: entry["destination"])


def summarize_mounts(mounts: object, working: str | None) -> tuple[str | None, str, list[dict]]:
    mounts = validate_mounts(mounts)
    anchors = {}
    for mount in mounts:
        destination = path(mount["Destination"])
        kind = text(mount.get("Type"), 32)
        if destination in {"/data/.env", "/data/docker-compose.yml"} and kind == "bind":
            source = path(mount.get("Source"))
            suffix = destination.removeprefix("/data/")
            if source and posixpath.basename(source) == suffix:
                anchors[destination] = posixpath.dirname(source)
    anchored = next(iter(anchors.values())) if len(anchors) == 2 and len(set(anchors.values())) == 1 else None
    if anchored == "/":
        anchored = None
    if len(anchors) == 2 and len(set(anchors.values())) != 1 or working and anchored and working != anchored:
        root, status = None, "conflicting-paths"
    elif anchored:
        root, status = anchored, "confirmed-by-mounts"
    else:
        root, status = working, "requires-path-verification"
    return root, status, storage_mounts(mounts, root)


def inspect_container(reader: DockerReader, row: dict) -> dict:
    core = reader.core(row["id"])
    if core.get("id") != row["id"] or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(core.get("imageId"))):
        raise InspectionError("A container changed during discovery; inspect again")
    return core


def published_ports(reader: DockerReader, rows: list[dict]) -> list[dict]:
    ports = []
    for row in rows:
        if row["state"] not in {"running", "restarting", "paused"} or not row["publishedPorts"]:
            continue
        bindings = reader.ports(row["id"]).get("bindings")
        if bindings is None:
            continue
        if not isinstance(bindings, dict):
            raise InspectionError("Docker returned invalid published ports")
        for protocol, values in bindings.items():
            if values is None:
                continue
            if not re.fullmatch(r"\d+/(?:tcp|udp|sctp)", protocol) or not isinstance(values, list):
                raise InspectionError("Docker returned invalid published ports")
            for value in values:
                if not isinstance(value, dict) or not re.fullmatch(r"\d{1,5}", str(value.get("HostPort", ""))):
                    raise InspectionError("Docker returned invalid published ports")
                number = int(value["HostPort"])
                if not 1 <= number <= 65535:
                    raise InspectionError("Docker returned invalid published ports")
                if number in CORE_PORTS and protocol.endswith("/tcp"):
                    ports.append({"port": number, "container": row["name"], "containerId": row["id"]})
    return sorted({(value["port"], value["containerId"]): value for value in ports}.values(), key=lambda value: (value["port"], value["containerId"]))


def app_directory_evidence(row: dict, installation: dict) -> tuple[list[str], str | None]:
    if installation["rootStatus"] != "confirmed-by-mounts":
        return [], "Controller installation root is not confirmed by its mounts"
    mounts = [item for item in installation["storage"] if item["type"] == "bind" and item["destination"] == "/data/apps"]
    if not mounts:
        return [], "Controller has no confirmed apps bind mount"

    def mapped(directory):
        candidates = set()
        for mount in mounts:
            source = mount["source"]
            if directory and directory != source and beneath(directory, source):
                candidates.add(directory)
            if directory and directory != mount["destination"] and beneath(directory, mount["destination"]):
                relative = posixpath.relpath(directory, mount["destination"])
                parts = relative.split("/")
                # Older containers can lack appurn. Their Compose path must still
                # identify one app under the controller's actual apps bind.
                if row["appUrn"] and (len(parts) != 2 or row["appUrn"] != f"{parts[1]}:{parts[0]}"):
                    return set(), "App URN conflicts with the controller-local Compose directory"
                if len(parts) in {1, 2}:
                    candidates.add(posixpath.join(source, relative))
        return candidates, None

    working = path(row["workingDir"])
    directories, reason = mapped(working)
    if reason:
        return [], reason
    files = set()
    config_files = row.get("configFiles", "")
    for filename in config_files.split(",") if config_files else []:
        filename = path(filename) or (path(posixpath.join(working, filename)) if working else None)
        if filename and posixpath.basename(filename) in {"docker-compose.generated.yml", "docker-compose.yml"}:
            found, reason = mapped(posixpath.dirname(filename))
            if reason:
                return [], reason
            files.update(found)
    if directories and files and directories != files:
        return [], "Compose working directory and config files identify different apps"
    if config_files and not files:
        return [], "Compose config files do not identify an app in this controller's apps bind mount"
    candidates = files or directories
    return sorted(candidates), None if candidates else "Compose paths do not identify an app in this controller's apps bind mount"


def app_directories(row: dict, installation: dict) -> list[str]:
    return app_directory_evidence(row, installation)[0]


def discover(reader: DockerReader, *, resolve_app_owners=None) -> dict:
    daemon = reader.daemon()
    rows = reader.containers()
    validate_rows(rows)
    installations = []
    for row in rows:
        brand = image_brand(row["image"])
        if brand is None and not (row["project"] == "runtipi" and row["service"] == "runtipi"):
            continue
        # An app can use a control-plane image without being the installed controller.
        if row["service"] and row["service"] != "runtipi":
            continue
        core = inspect_container(reader, row)
        root, root_status, storage = summarize_mounts(core.get("mounts"), path(row["workingDir"]))
        version = reader.image(core["imageId"]).get("version")
        version = version.removeprefix("v") if isinstance(version, str) and VERSION.fullmatch(version) else None
        if not version and ":" in row["image"].split("/")[-1] and "@" not in row["image"]:
            tag = row["image"].rsplit(":", 1)[1]
            version = tag.removeprefix("v") if VERSION.fullmatch(tag) else None
        ownership = row["project"] == "runtipi" and row["service"] == "runtipi"
        owned = {
            item["id"] for item in rows
            if ownership and root and item["project"] == row["project"] and item["service"] in CORE_SERVICES
            and path(item["workingDir"]) == root
        }
        reasons = []
        if brand is None:
            reasons.append("unrecognized-controller-image")
        if not ownership:
            reasons.append("compose-ownership-unverified")
        if not path(row["workingDir"]):
            reasons.append("compose-working-directory-unverified")
        if root_status != "confirmed-by-mounts":
            reasons.append("installation-root-unverified")
        if brand == "runtipi" and version != "4.10.1":
            reasons.append("runtipi-version-requires-review")
        fingerprint = hashlib.sha256(json.dumps({"daemon": daemon, "container": row["id"], "image": core["imageId"], "root": root, "storage": storage}, sort_keys=True).encode()).hexdigest()
        installations.append({
            "id": fingerprint, "product": brand or "unrecognized", "version": version,
            "container": {"id": row["id"], "name": row["name"], "state": row["state"]},
            "installRoot": root, "rootStatus": root_status, "storage": storage,
            "reviewRequired": reasons, "ownedCoreContainers": sorted(owned), "apps": [],
            "choices": [
                {"mode": "keep", "label": "Replace Runtipi and keep data"},
                {"mode": "fresh", "label": "Replace Runtipi and start fresh"},
            ] if brand == "runtipi" else [],
        })
    unassigned = []
    host_files_inspected = False
    controllers = {item["container"]["id"] for item in installations}
    # Core services can carry runtipi.managed too. They have already been
    # classified by project, service and installation root, not by their name.
    core_ids = {identifier for item in installations for identifier in item["ownedCoreContainers"]}
    for row in rows:
        if row["id"] in controllers | core_ids or row["managed"].lower() != "true":
            continue
        owners = [item for item in installations if app_directories(row, item)]
        candidates = len(owners)
        if len(owners) > 1 and resolve_app_owners is not None:
            owners = resolve_app_owners(row, owners)
            host_files_inspected = True
        summary = {"container": {"id": row["id"], "name": row["name"], "state": row["state"]}, "appUrn": row["appUrn"] or None}
        if len(owners) != 1:
            summary["compose"] = {"project": row["project"], "service": row["service"], "workingDir": row["workingDir"], "configFiles": row.get("configFiles", "")}
            summary["ownershipReasons"] = (
                ["Compose paths match multiple controllers; no unique local app configuration could establish ownership"] if candidates > 1
                else sorted({app_directory_evidence(row, item)[1] for item in installations}) if installations
                else ["No controller with a confirmed installation root was found"]
            )
            unassigned.append(summary)
            continue
        owner = owners[0]
        core = inspect_container(reader, row)
        summary["storage"] = storage_mounts(validate_mounts(core.get("mounts")), owner["installRoot"], app=True)
        owner["apps"].append(summary)
    for installation in installations:
        installation["apps"].sort(key=lambda value: value["container"]["id"])
    ports = published_ports(reader, rows)
    names = [{"container": row["name"], "containerId": row["id"]} for row in rows if row["name"] in CORE_SERVICES]
    for installation in installations:
        owned = set(installation.pop("ownedCoreContainers"))
        installation["nameConflicts"] = [value for value in names if value["containerId"] not in owned]
        installation["freshPortConflicts"] = [value for value in ports if value["containerId"] not in owned]
    after = reader.containers()
    validate_rows(after)
    if reader.daemon() != daemon or sorted(rows, key=lambda value: value["id"]) != sorted(after, key=lambda value: value["id"]):
        raise InspectionError("Docker changed during discovery; inspect again before choosing an installation")
    if len(installations) > 1:
        result = "select-installation"
    elif installations:
        result = {"runtipi": "runtipi-found", "orbis": "orbis-found"}.get(installations[0]["product"], "installation-requires-review")
    else:
        result = "installation-requires-review" if unassigned else "conflicts-found" if names or ports else "no-controller-found"
    return {
        "schema": SCHEMA, "readOnly": True, "result": result, "dockerContext": reader.context,
        "daemonFingerprint": hashlib.sha256(daemon.encode()).hexdigest(),
        "installations": sorted(installations, key=lambda item: (item["installRoot"] or "", item["id"])),
        "newInstallationConflicts": {"names": names, "ports": ports},
        "unassignedManagedContainers": sorted(unassigned, key=lambda item: item["container"]["id"]),
        "hostFilesInspected": host_files_inspected, "nativeHostPortsInspected": False, "executionAllowed": False,
        "requiredNextStep": "review-installation-and-backup-plan",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docker-context", required=True, help="Docker context on the host to inspect; never changes the selected context")
    args = parser.parse_args()
    try:
        print(json.dumps(discover(DockerReader(args.docker_context)), indent=2))
        return 0
    except (InspectionError, ValueError) as error:
        print(json.dumps({"schema": SCHEMA, "readOnly": True, "result": "inspection-failed", "message": str(error)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
