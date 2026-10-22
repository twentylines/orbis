#!/usr/bin/env python3
"""Install Orbis or replace a discovered Runtipi installation on this host."""

import argparse
import copy
import hashlib
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path


def load(name, module_name):
    import importlib.util
    spec = importlib.util.spec_from_file_location(module_name, Path(__file__).with_name(name))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


REPLACE = load("orbis-install-replace.py", "orbis_guided_replace")
HOST = REPLACE.HOST
APPS = REPLACE.APPS
UI = load("orbis-install-ui.py", "orbis_guided_ui")


class Terminal:
    def __init__(self):
        self.reader = open("/dev/tty", "r", encoding="utf-8")
        try:
            self.writer = open("/dev/tty", "w", encoding="utf-8")
        except OSError:
            self.reader.close()
            raise

    def ask(self, question):
        self.writer.write(question)
        self.writer.flush()
        answer = self.reader.readline()
        if not answer:
            raise ValueError("Installation cancelled")
        return answer

    def close(self):
        self.reader.close()
        self.writer.close()


def safe_root(path):
    path = path.expanduser().absolute()
    if path != path.resolve(strict=False) or any(ord(char) < 32 or ord(char) == 127 for char in str(path)):
        raise ValueError("Choose an absolute installation path without symlinks or control characters")
    return path


def select_installation(report, root=None, ask=None):
    installations = report["installations"]
    if root is not None:
        matches = [item for item in installations if item.get("installRoot") == str(root)]
        if len(matches) > 1:
            raise ValueError("Multiple controllers use that installation; resolve the conflict first")
        if matches:
            return matches[0]
        if installations:
            raise ValueError("Another controller already occupies this Docker host; select its installation root")
        return None
    if len(installations) == 1:
        return installations[0]
    if not installations:
        return None
    if ask is None:
        raise ValueError("Several installations were found; provide --root")
    print("Installations found:")
    for index, item in enumerate(installations, 1):
        print(f"  {index}. {item['product']} {item.get('version') or ''} — {item.get('installRoot') or 'unconfirmed root'}")
    answer = ask("Select an installation number: ").strip()
    if not answer.isdigit() or not 1 <= int(answer) <= len(installations):
        raise ValueError("No installation was selected")
    return installations[int(answer) - 1]


def semantic_review(value):
    result = copy.deepcopy(value)
    result.pop("reviewId", None)
    checkpoint = result["checkpoint"]
    checkpoint.pop("reviewId", None)
    storage = checkpoint["storage"]
    storage.pop("reviewId", None)
    storage.pop("estimatedBytes", None)
    return result


def command(arguments, out, err):
    with out.open("xb") as stdout, err.open("xb") as stderr:
        result = subprocess.run([sys.executable, *arguments], stdout=stdout, stderr=stderr, check=False)
    return result.returncode


def recover_pending(root, reader, state, ask, *, writers_stopped=False):
    path = root / ".orbis-installation.json"
    if not path.exists() and not path.is_symlink():
        return None
    marker = REPLACE.TX.RESTORE.private_json(path)
    if marker.get("schema") != "orbis.installer-pointer.v1" or marker.get("root") != str(root) or marker.get("dockerContext") != reader.context or marker.get("kind") not in {"new", "replacement"}:
        raise ValueError("The installation recovery marker needs local review")
    journal = Path(marker["journal"])
    if not journal.exists():
        return None
    record = REPLACE.TX.RESTORE.private_json(journal)
    scope = record.get("review") if marker["kind"] == "replacement" else record
    if not isinstance(scope, dict) or scope.get("root") != str(root) or scope.get("dockerContext") != reader.context:
        raise ValueError("The recovery journal belongs to another installation")
    if record.get("stage") in {"complete", "rolled-back"}:
        return None
    if marker["kind"] == "replacement" and not writers_stopped:
        if ask is None or ask("Stop native and remote storage writers before recovery. Ready? [y/N]: ").strip().lower() != "y":
            raise ValueError("Interrupted replacement recovery requires stopped native and remote writers")
    if ask is not None and ask(f"Resume the interrupted installation at {root}? [Y/n]: ").strip().lower() not in {"", "y"}:
        raise ValueError("Recovery cancelled; the journal was preserved")
    executor = Path(marker["executor"])
    if executor.is_symlink() or not executor.is_file() or executor.stat().st_uid != os.geteuid() or hashlib.sha256(executor.read_bytes()).hexdigest() != marker["executorSha256"]:
        raise ValueError("The original verified recovery executor is missing or changed")
    expected_name = "orbis-install-new.py" if marker["kind"] == "new" else "orbis-install-replace.py"
    if executor.name != expected_name:
        raise ValueError("The recovery executor has an unexpected name")
    private = load("install-orbis.py", "orbis_recovery_private")
    private.private_directory(state)
    name = "recovery-" + str(uuid.uuid4())
    arguments = [str(executor), "recover", str(root), "--docker-context", reader.context, "--journal", str(journal), "--confirm-root", str(root)]
    if marker["kind"] == "replacement":
        arguments.append("--host-writers-stopped")
    code = command(arguments, state / (name + ".stdout.json"), state / (name + ".stderr.json"))
    if code:
        raise ValueError(f"Recovery did not finish. Preserve {journal} and the private logs in {state}")
    return json.loads((state / (name + ".stdout.json")).read_text())


def replacement(root, reader, manifest, state, mode, confirm, display=None):
    REPLACE.TX.RESTORE.runtime()
    run = state / ("replacement-" + str(uuid.uuid4()))
    run.mkdir(mode=0o700)
    backup, journal = run / "backup", run / "transaction.json"
    review_path = run / "review.json"
    display = display or UI.Presentation(interactive=False)
    with display.step("Reviewing app ownership and backup storage"):
        with HOST.host_lock(root) as descriptor:
            reader.lock_fd = descriptor
            review = REPLACE.review(root, reader, manifest, backup, journal, mode=mode)
    reader.lock_fd = None
    APPS.write_journal(review_path, review)
    count = list(review["checkpoint"]["roles"].values()).count("app")
    print(f"\nInstallation: {root}\nRelease: {manifest['tag']}\nMode: {mode.title()}\nApp containers: {count}\nBackup: {backup}\n")
    if mode == "fresh":
        print("Fresh removes dashboard accounts, saved links and workspace preferences. Apps and their data are retained. Existing logins will be revoked.")
    else:
        print("Keep preserves accounts, settings, installed apps and their data.")
    confirm(root)
    script = str(Path(__file__).with_name("orbis-install-replace.py"))
    APPS.write_journal(root / ".orbis-installation.json", {"schema": "orbis.installer-pointer.v1", "root": str(root), "dockerContext": reader.context, "kind": "replacement", "journal": str(journal), "executor": script, "executorSha256": hashlib.sha256(Path(script).read_bytes()).hexdigest()})
    arguments = [script, "apply", str(root), "--docker-context", reader.context, "--mode", mode, "--review", str(review_path), "--journal", str(journal), "--confirm-root", str(root), "--host-writers-stopped"]
    for attempt in range(3):
        code = None
        with display.step("Backing up storage and replacing the controller", completed=lambda: code == 0):
            code = command(arguments, run / f"apply-{attempt}.stdout.json", run / f"apply-{attempt}.stderr.json")
            if code and (journal.exists() or attempt == 2):
                raise ValueError(f"Installation did not complete. Preserve {run}. Recover with: python3 {script} recover {root} --docker-context {reader.context} --journal {journal} --confirm-root {root} --host-writers-stopped")
        if code == 0:
            result = json.loads((run / f"apply-{attempt}.stdout.json").read_text())
            if result.get("result") != "orbis-installed" or result.get("mode") != mode:
                raise ValueError("The executor did not report a completed installation; preserve its journal")
            return result
        with HOST.host_lock(root) as descriptor:
            reader.lock_fd = descriptor
            refreshed = REPLACE.review(root, reader, manifest, backup, journal, mode=mode)
        reader.lock_fd = None
        if semantic_review(refreshed) != semantic_review(review):
            raise ValueError("Installation configuration or container identities changed after confirmation. Nothing was replaced; run the installer again")
        print("Storage usage changed while the host was live; refreshing the size estimate.", flush=True)
        review = refreshed
        APPS.write_journal(review_path, review)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--state-dir", type=Path, required=True)
    parser.add_argument("--docker-context", default="default")
    parser.add_argument("--root", type=Path)
    parser.add_argument("--mode", choices=("keep", "fresh"))
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--yes", action="store_true")
    parser.add_argument("--host-writers-stopped", action="store_true")
    parser.add_argument("--without-host-service", action="store_true")
    parser.add_argument("--no-animation", action="store_true", help="show static installation progress")
    parser.add_argument("--no-color", action="store_true", help="disable terminal colours")
    parser.add_argument("--http-port", type=int, default=80)
    parser.add_argument("--https-port", type=int, default=443)
    parser.add_argument("--server-ip")
    args = parser.parse_args()
    if sys.platform != "linux" or os.geteuid() != 0 or sys.version_info < (3, 10):
        raise ValueError("Run the installer as root on Linux with Python 3.10 or newer")
    manifest = HOST.PLAN.require_installation_protocol(json.loads(args.manifest.read_text()))
    reader = APPS.Docker(args.docker_context)
    REPLACE.Engine(reader)
    if args.inspect:
        report = APPS.DETECT.discover(reader)
        print(json.dumps(report, indent=2))
        return 0
    display = UI.Presentation(interactive=not args.yes, color=not args.no_color, animation=not args.no_animation)
    display.banner(manifest["tag"])
    with display.step("Detecting existing installations"):
        report = APPS.DETECT.discover(reader, resolve_app_owners=APPS.local_app_owners)
    tty = None
    try:
        if not args.yes:
            try:
                tty = Terminal()
            except OSError as error:
                raise ValueError("An interactive terminal is required, or provide --yes with an explicit --root and mode") from error
        elif args.root is None:
            raise ValueError("Unattended installation requires an explicit --root")

        def ask(question):
            if tty is None:
                raise ValueError("An interactive terminal is required")
            return tty.ask(question)

        supplied_root = safe_root(args.root) if args.root else None
        roots = {item["installRoot"] for item in report["installations"] if item.get("installRoot")}
        possible_root = supplied_root or (safe_root(Path(next(iter(roots)))) if len(roots) == 1 else None)
        if possible_root:
            recovered = recover_pending(possible_root, reader, args.state_dir.expanduser(), None if args.yes else ask, writers_stopped=args.host_writers_stopped)
            if recovered:
                print(json.dumps(recovered, indent=2))
                print("Recovery completed. Run the installer again to continue setup.")
                return 0
        selected = select_installation(report, supplied_root, None if args.yes else ask)
        root = safe_root(Path(selected["installRoot"])) if selected and selected.get("installRoot") else supplied_root
        if selected and (not root or selected["reviewRequired"]):
            raise ValueError("The detected controller version, ownership or layout needs compatibility review before replacement")
        if selected and selected["product"] == "orbis":
            if args.mode:
                raise ValueError("Orbis is already installed. Use Settings for resets or Updates for a core update")
            print(f"Orbis is already installed at {root}.")
            if not args.without_host_service:
                enable = load("orbis-host-service-enable.py", "orbis_guided_enable")
                enable.enable(root, reader.context, Path(__file__).parent)
            return 0
        if selected and selected["product"] != "runtipi":
            raise ValueError("The controller cannot be replaced automatically")
        if selected:
            with display.step("Checking managed-container ownership"):
                APPS.require_assigned(report)
        if root is None:
            answer = ask("Installation directory [/opt/orbis/server]: ").strip()
            root = safe_root(Path(answer or "/opt/orbis/server"))
        mode = args.mode
        if selected and mode is None:
            if args.yes:
                raise ValueError("Unattended Runtipi replacement requires --mode keep or --mode fresh")
            print(f"\nDetected Runtipi {selected['version']} at {root}\n  1. Keep accounts, settings and apps\n  2. Start fresh with new accounts; retain apps and data")
            answer = ask("Replacement choice [1]: ").strip()
            if answer not in {"", "1", "2"}:
                raise ValueError("Choose Keep or Fresh")
            mode = "fresh" if answer == "2" else "keep"
        if not selected and mode is not None:
            raise ValueError("No Runtipi installation matches the requested replacement mode")
        enable = load("orbis-host-service-enable.py", "orbis_guided_enable")
        if not args.without_host_service:
            enable.available(root, reader.context)
        with display.step("Verifying the Orbis release"):
            REPLACE.UPDATE.verify_release(manifest)
        private = load("install-orbis.py", "orbis_guided_private")
        state = private.private_directory(args.state_dir.expanduser())
        with display.step("Downloading the verified Orbis image"):
            with (state / ("image-pull-" + str(uuid.uuid4()) + ".log")).open("xb") as log:
                pulled = subprocess.run(["docker", "--context", reader.context, "pull", REPLACE.target_image(manifest)], stdout=log, stderr=subprocess.STDOUT, check=False, timeout=900)
            if pulled.returncode:
                raise RuntimeError(f"Docker could not pull the verified image; inspect the private logs in {state}")
        enable.require_scoped_cleanup(root, reader.context, REPLACE.target_image(manifest))

        def confirm(chosen):
            if selected and not args.host_writers_stopped:
                if args.yes or ask("Have native host processes and remote clients writing to this app storage been stopped? [y/N]: ").strip().lower() != "y":
                    raise ValueError("Stop native and remote storage writers before replacing the installation")
            if not args.yes and ask(f"Type {chosen} to confirm installation: ").strip() != str(chosen):
                raise ValueError("Installation cancelled; no controller was replaced")

        if selected:
            result = replacement(root, reader, manifest, state, mode, confirm, display)
        else:
            new = load("orbis-install-new.py", "orbis_guided_new")
            result = new.install(root, reader, manifest, state, args, confirm, display=display)
        if not args.without_host_service:
            with display.step("Enabling system administration"):
                enable.enable(root, reader.context, Path(__file__).parent)
        print(f"\nOrbis {manifest['tag']} is installed at {root}. Open the server address in your browser to sign in or create an administrator.")
        print(json.dumps(result, indent=2))
        return 0
    finally:
        if tty:
            tty.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nInstallation interrupted. Keep the recovery files before retrying.", file=sys.stderr)
        sys.exit(130)
    except (OSError, ValueError, RuntimeError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        print(f"Orbis installation stopped: {error}", file=sys.stderr)
        sys.exit(2)
