#!/usr/bin/env python3
"""Initialize an empty Orbis installation and resume its recorded startup."""

import argparse
import contextlib
import errno
import hashlib
import importlib.util
import ipaddress
import json
import os
import secrets
import socket
import stat
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("orbis_new_replace", Path(__file__).with_name("orbis-install-replace.py"))
REPLACE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPLACE)
HOST, APPS = REPLACE.HOST, REPLACE.APPS
UI = REPLACE.load("orbis-install-ui.py", "orbis_new_ui")
SCHEMA = "orbis.new-installation.v1"
IMAGES = {
    "postgres": "postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24",
    "rabbitmq": "rabbitmq@sha256:8668a6ed4a878a6619213d9d5721dd4983ecb662312fe233816e1d1ff8a96753",
    "traefik": "traefik@sha256:31267173a15b4944e797a76ffd9c419707c8d8b32fe5b610f80cd0cfa05f372d",
}
NETWORK = "runtipi_tipi_main_network"


class PortInUseError(ValueError):
    def __init__(self, port, owner="a host service"):
        self.port = port
        super().__init__(f"Dashboard port {port} is already used by {owner}")


def server_ip(value=None):
    if value is None:
        route = subprocess.run(["ip", "-j", "route", "get", "192.0.2.1"], capture_output=True, text=True, check=False)
        try:
            value = json.loads(route.stdout)[0]["prefsrc"]
        except (KeyError, IndexError, ValueError):
            raise ValueError("Provide the server's LAN or VPN address with --server-ip") from None
    address = ipaddress.ip_address(value)
    if address.is_unspecified or address.is_multicast or address.is_loopback:
        raise ValueError("Use the server's LAN or VPN address, not a loopback or unspecified address")
    return str(address)


def compose(root, image, endpoint, http, https):
    def bind(source, target, readonly=False):
        return {"type": "bind", "source": str(source), "target": target, "read_only": readonly, "bind": {"create_host_path": False}}
    common = {"restart": "unless-stopped", "networks": ["tipi_main_network"]}
    core = {**common, "container_name": "runtipi", "image": image, "env_file": [str(root / ".env")], "environment": {"NODE_ENV": "production"}, "depends_on": {"runtipi-db": {"condition": "service_healthy"}, "runtipi-queue": {"condition": "service_started"}}, "healthcheck": {"test": ["CMD", "curl", "-fsS", "http://127.0.0.1:3000/api/health"], "interval": "3s", "timeout": "3s", "retries": 60, "start_period": "15s"}}
    folders = ["media", "state", "repos", "apps", "logs", "traefik", "user-config", "backups"]
    core["volumes"] = [bind(root / name, "/data/" + name) for name in folders]
    core["volumes"] += [bind(root / "app-data", "/app-data"), bind(root / "cache", "/cache"), bind(root / ".env", "/data/.env"), bind(root / "docker-compose.yml", "/data/docker-compose.yml", True), bind(endpoint, "/var/run/docker.sock", True)]
    for source, target in [("/proc/meminfo", "/host/proc/meminfo"), ("/proc/stat", "/host/proc/stat"), ("/proc/uptime", "/host/proc/uptime"), ("/etc/localtime", "/etc/localtime")]:
        if Path(source).is_file():
            core["volumes"].append(bind(source, target, True))
    core["labels"] = {"runtipi.managed": "true", "traefik.enable": "true", "traefik.http.services.dashboard.loadbalancer.server.port": "3000", "traefik.http.routers.dashboard.rule": "PathPrefix(`/`)", "traefik.http.routers.dashboard.entrypoints": "web", "traefik.http.routers.dashboard.service": "dashboard", "traefik.http.routers.dashboard-secure.rule": "PathPrefix(`/`)", "traefik.http.routers.dashboard-secure.entrypoints": "websecure", "traefik.http.routers.dashboard-secure.service": "dashboard", "traefik.http.routers.dashboard-secure.tls": "true", "traefik.http.middlewares.runtipi.forwardauth.address": "http://runtipi:3000/api/auth/traefik", "traefik.http.middlewares.runtipi.forwardauth.authRequestHeaders": "Cookie", "traefik.http.middlewares.runtipi.forwardauth.maxResponseBodySize": "8192"}
    return {"services": {
        "runtipi": core,
        "runtipi-db": {**common, "container_name": "runtipi-db", "image": IMAGES["postgres"], "stop_grace_period": "1m", "environment": {"POSTGRES_USER": "tipi", "POSTGRES_DB": "tipi", "POSTGRES_PASSWORD": "${POSTGRES_PASSWORD:?}"}, "volumes": [bind(root / "data/postgres", "/var/lib/postgresql/data")], "healthcheck": {"test": ["CMD-SHELL", "pg_isready -U tipi -d tipi"], "interval": "3s", "timeout": "3s", "retries": 60}},
        "runtipi-queue": {**common, "container_name": "runtipi-queue", "image": IMAGES["rabbitmq"], "environment": {"RABBITMQ_DEFAULT_USER": "tipi", "RABBITMQ_DEFAULT_PASS": "${RABBITMQ_PASSWORD:?}"}, "volumes": [bind(root / "data/rabbitmq", "/var/lib/rabbitmq")]},
        "runtipi-reverse-proxy": {**common, "container_name": "runtipi-reverse-proxy", "image": IMAGES["traefik"], "depends_on": {"runtipi": {"condition": "service_healthy"}}, "ports": [f"{http}:80", f"{https}:443"], "volumes": [bind(root / "traefik", "/etc/traefik"), bind(root / "traefik/shared", "/shared"), bind(endpoint, "/var/run/docker.sock", True)]},
    }, "networks": {"tipi_main_network": {"name": NETWORK, "driver": "bridge", "labels": {"orbis.managed": "true"}}}}


def require_empty(root, reader, http, https):
    if root.is_symlink() or (root.exists() and (not root.is_dir() or any(root.iterdir()))):
        raise ValueError("New installations require an empty directory; existing files were preserved")
    if any(char in str(root) for char in "'\"\\$\r\n"):
        raise ValueError("Choose an installation path without quotes, backslashes or variable characters")
    if any(type(port) is not int or not 1 <= port <= 65535 for port in (http, https)) or http == https:
        raise ValueError("Choose two different valid HTTP and HTTPS ports")
    if any(row["name"] in APPS.DETECT.CORE_SERVICES for row in reader.containers()):
        raise ValueError("Reserved controller containers already exist on this Docker host")
    if NETWORK in reader._read(["network", "ls", "--format", "{{.Name}}"] ).splitlines():
        raise ValueError("The controller network already exists; review the previous installation first")
    published = APPS.DETECT.published_ports(reader, reader.containers(), wanted={http, https})
    if published:
        raise PortInUseError(published[0]["port"], f"Docker container {published[0]['container']}")
    for port in (http, https):
        families = (socket.AF_INET, socket.AF_INET6) if socket.has_ipv6 else (socket.AF_INET,)
        for family in families:
            try:
                with socket.socket(family, socket.SOCK_STREAM) as probe:
                    if family == socket.AF_INET6:
                        probe.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                    probe.bind(("::" if family == socket.AF_INET6 else "0.0.0.0", port))
            except OSError as error:
                if family == socket.AF_INET6 and error.errno in {errno.EAFNOSUPPORT, errno.EADDRNOTAVAIL, errno.ENOPROTOOPT}:
                    continue
                raise PortInUseError(port) from error


def choose_ports(root, reader, http, https, ask=None):
    error = None
    for attempt in range(17):
        if error is None:
            try:
                require_empty(root, reader, http, https)
                return http, https
            except PortInUseError as conflict:
                error = conflict
        if error is not None:
            if ask is None:
                flag = "--http-port" if error.port == http else "--https-port"
                raise ValueError(f"{error}. Choose another port with {flag}") from error
            if attempt == 16:
                break
            protocol = "HTTP" if error.port == http else "HTTPS"
            answer = ask(f"{error}.\nChoose a different {protocol} port (Enter to cancel): ").strip()
            if not answer:
                raise ValueError("Installation cancelled; existing containers were preserved")
            if not answer.isascii() or not answer.isdigit() or len(answer) > 5 or not 1 <= int(answer) <= 65535 or int(answer) == (https if protocol == "HTTP" else http):
                print("Enter a port between 1 and 65535, different from the other dashboard port.", file=sys.stderr)
                continue
            if protocol == "HTTP":
                http = int(answer)
            else:
                https = int(answer)
            error = None
    raise ValueError("Too many port attempts; choose free --http-port and --https-port values")


def pointer(root, run, reader):
    script = Path(__file__).resolve()
    APPS.write_journal(root / ".orbis-installation.json", {"schema": "orbis.installer-pointer.v1", "root": str(root), "dockerContext": reader.context, "kind": "new", "journal": str(run / "transaction.json"), "executor": str(script), "executorSha256": hashlib.sha256(script.read_bytes()).hexdigest()})


def finish(record, reader, journal):
    root = Path(record["root"])
    if APPS.digest_daemon(reader) != record["daemon"]:
        raise ValueError("The Docker daemon changed during installation")
    marker = REPLACE.TX.RESTORE.private_json(root / ".orbis-installation.json")
    if marker.get("journal") != str(journal) or marker.get("dockerContext") != reader.context or marker.get("root") != str(root):
        raise ValueError("The installation marker belongs to another transaction")
    if record["stage"] == "prepared":
        for name in ["media", "state", "repos", "apps", "logs", "traefik/dynamic", "traefik/shared", "traefik/tls", "user-config", "backups", "app-data", "cache", "data/postgres", "data/rabbitmq"]:
            target = root / name
            target.mkdir(mode=0o700, parents=True, exist_ok=True)
            if target.is_symlink() or not target.is_dir():
                raise ValueError("An installation directory changed during initialization")
        for name, expected in record["files"].items():
            source = journal.parent / "files" / name
            if hashlib.sha256(source.read_bytes()).hexdigest() != expected:
                raise ValueError("The private installation source changed")
            destination = root / name
            if destination.exists() or destination.is_symlink():
                if destination.is_symlink() or not destination.is_file() or hashlib.sha256(destination.read_bytes()).hexdigest() != expected:
                    raise ValueError("An installation file was changed before initialization completed")
            else:
                descriptor, temporary = tempfile.mkstemp(prefix=".orbis-init-", dir=root)
                with os.fdopen(descriptor, "wb") as output:
                    output.write(source.read_bytes()); output.flush(); os.fsync(output.fileno())
                if destination.exists() or destination.is_symlink():
                    Path(temporary).unlink()
                    raise ValueError("An installation file appeared during initialization; preserve it for review")
                os.replace(temporary, destination)
                descriptor = os.open(root, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        record["stage"] = "starting"
        APPS.write_journal(journal, record)
    if record["stage"] not in {"starting", "enrolled"}:
        raise ValueError("This installation transaction cannot be replayed")
    environment = (root / ".env").lstat()
    if not stat.S_ISREG(environment.st_mode) or environment.st_nlink != 1 or environment.st_uid != os.geteuid() or stat.S_IMODE(environment.st_mode) & 0o077:
        raise ValueError("The server environment must remain a private regular file")
    for name in ("docker-compose.yml", "VERSION", "orbis-compose.yml"):
        if (root / name).is_symlink() or hashlib.sha256((root / name).read_bytes()).hexdigest() != record["files"][name]:
            raise ValueError("Controller configuration changed during startup; preserve the transaction")
    result = HOST.docker(reader.context, HOST.compose_args(root) + ["up", "--detach", "--pull", "never", "--no-build", "--wait", "--wait-timeout", "240"], root)
    if result.returncode:
        raise RuntimeError(f"Controller startup did not finish. Rerun the installer for {root} to resume; preserve {journal}")
    manifest = record["manifest"]
    core = HOST.current_core(root, reader.context)
    if core.get("state") != "running" or core.get("health") != "healthy" or core.get("image") != REPLACE.target_image(manifest):
        raise RuntimeError("The new controller did not reach its pinned healthy image")
    HOST.write_state(root, HOST.installation_fingerprint(root, manifest, reader.context))
    record["stage"] = "complete"
    APPS.write_journal(journal, record)
    return {"result": "orbis-installed", "mode": "new", "releaseTag": manifest["tag"], "journal": str(journal)}


def install(root, reader, manifest, state, args, confirm, display=None):
    require_empty(root, reader, args.http_port, args.https_port)
    address = server_ip(args.server_ip)
    endpoint = REPLACE.Engine(reader).endpoint
    run = state / ("new-" + str(uuid.uuid4())); run.mkdir(mode=0o700)
    print(f"\nNew installation: {root}\nServer: {address}\nDashboard ports: {args.http_port} / {args.https_port}\nRelease: {manifest['tag']}\n")
    confirm(root)
    for name, image in IMAGES.items():
        pull_log = run / (name + "-pull.log")
        with display.step(f"Downloading {name}", detail=UI.PullProgress(pull_log)) if display else contextlib.nullcontext():
            if display is None:
                print(f"Downloading {name}…", flush=True)
            with pull_log.open("xb") as log:
                result = subprocess.run(["docker", "--context", reader.context, "pull", image], stdout=log, stderr=subprocess.STDOUT, check=False, timeout=900)
            if result.returncode:
                raise RuntimeError(f"A required image could not be downloaded. Installation directory is unchanged; logs: {run}")
    root.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    for parent in [root.parent, *root.parent.parents]:
        details = parent.lstat()
        if not stat.S_ISDIR(details.st_mode) or details.st_uid != 0 or stat.S_IMODE(details.st_mode) & 0o022:
            raise ValueError("The installation parent must be root-owned and not writable by other users")
    with HOST.host_lock(root):
        require_empty(root, reader, args.http_port, args.https_port)
        values = {"ROOT_FOLDER_HOST": str(root), "INTERNAL_IP": address, "TIPI_VERSION": "4.10.1", "JWT_SECRET": secrets.token_hex(64), "POSTGRES_PASSWORD": secrets.token_hex(32), "RABBITMQ_USERNAME": "tipi", "RABBITMQ_PASSWORD": secrets.token_hex(32), "RABBITMQ_HOST": "runtipi-queue", "NGINX_PORT": str(args.http_port), "NGINX_PORT_SSL": str(args.https_port), "TZ": "UTC", "LOCAL_DOMAIN": "orbis.lan", "DOMAIN": "orbis.invalid"}
        environment = "".join(f"{key}='{value}'\n" for key, value in values.items())
        files = {".env": environment.encode(), "VERSION": b"4.10.1\n", "docker-compose.yml": (json.dumps(compose(root, REPLACE.target_image(manifest), endpoint, args.http_port, args.https_port), indent=2) + "\n").encode(), "orbis-compose.yml": HOST.STAGE.staged_content(manifest).encode()}
        folder = run / "files"; folder.mkdir(mode=0o700)
        for name, data in files.items():
            (folder / name).write_bytes(data); (folder / name).chmod(0o600)
        record = {"schema": SCHEMA, "root": str(root), "dockerContext": reader.context, "daemon": APPS.digest_daemon(reader), "manifest": manifest, "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}, "stage": "prepared"}
        journal = run / "transaction.json"; APPS.write_journal(journal, record)
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        pointer(root, run, reader)
        with display.step("Starting Orbis and checking its health") if display else contextlib.nullcontext():
            return finish(record, reader, journal)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("recover",))
    parser.add_argument("root", type=Path)
    parser.add_argument("--docker-context", required=True)
    parser.add_argument("--journal", type=Path, required=True)
    parser.add_argument("--confirm-root", required=True)
    args = parser.parse_args()
    if sys.platform != "linux" or os.geteuid() != 0:
        raise ValueError("Run initialization recovery as root on the Linux Docker host")
    root = args.root.resolve(strict=True); HOST.require_confirmation(root, args.confirm_root)
    reader = APPS.Docker(args.docker_context); REPLACE.Engine(reader)
    with HOST.host_lock(root):
        record = REPLACE.TX.RESTORE.private_json(args.journal)
        if record.get("schema") != SCHEMA or record.get("root") != str(root) or record.get("dockerContext") != reader.context:
            raise ValueError("The new-installation journal belongs to another installation")
        print(json.dumps(finish(record, reader, args.journal), indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        print(f"Orbis initialization stopped: {error}", file=sys.stderr); sys.exit(2)
