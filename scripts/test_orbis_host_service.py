import importlib.util
import json
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_host_service", Path(__file__).with_name("orbis-host-service.py"))
assert SPEC and SPEC.loader
SERVICE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVICE)


def manifest(tag: str, digest_character: str) -> dict[str, str]:
    return {
        "schema": "orbis.release.v1",
        "image": "ghcr.io/twentylines/orbis",
        "tag": tag,
        "commit": "a" * 40,
        "digest": "sha256:" + digest_character * 64,
        "runtipiCompatibility": "4.10.1",
    }


CURRENT = manifest("v0.1.0-beta.6", "b")
TARGET = manifest("v0.1.0-beta.7", "c")


class HostServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name).resolve()
        self.root = base / "install"
        self.snapshots = base / "snapshots"
        self.state = base / "state"
        for directory in (self.root, self.snapshots, self.state):
            directory.mkdir(mode=0o700)
        for name in ("docker-compose.yml", ".env", "orbis-compose.yml"):
            (self.root / name).write_text("fixture\n")
        self.service = SERVICE.HostService(self.root, "test-daemon", self.snapshots, self.state)
        self.current = mock.patch.object(self.service, "current_manifest", return_value=CURRENT)
        self.current.start()
        self.addCleanup(self.current.stop)
        self.target = mock.patch.object(SERVICE, "manifest_for_tag", return_value=TARGET)
        self.target.start()
        self.addCleanup(self.target.stop)
        self.plan = mock.patch.object(SERVICE.UPDATE, "update_plan", return_value={"snapshotBytes": 12345})
        self.plan.start()
        self.addCleanup(self.plan.stop)

    def wait_for_job(self):
        for _ in range(100):
            record = SERVICE.read_private(self.service.job_file)
            if record and record["state"] not in {"running", "recovering"}:
                return record
            time.sleep(0.01)
        self.fail("background update did not finish")

    def test_plan_binds_target_and_update_uses_the_same_snapshot(self):
        planned = self.service.plan(TARGET["tag"])
        self.assertEqual(planned["snapshotBytes"], 12345)
        self.assertEqual(planned["targetDigest"], TARGET["digest"])
        with mock.patch.object(SERVICE.UPDATE, "apply_update") as update:
            accepted, launch = self.service.apply(planned["planId"])
            self.assertEqual(accepted["state"], "running")
            launch()
            job = self.wait_for_job()
        self.assertEqual(job["state"], "complete")
        args = update.call_args.args
        self.assertEqual(args[0:4], (self.root, CURRENT, TARGET, "test-daemon"))
        self.assertEqual(args[4], Path(job["snapshot"]))
        self.assertEqual(args[4].parent, self.snapshots)

    def test_helper_maintenance_rejects_new_core_operations(self):
        planned = self.service.plan(TARGET["tag"])
        SERVICE.write_private(self.service.maintenance_file, {"schema": "orbis.helper-upgrade.v1"})
        with self.assertRaisesRegex(ValueError, "maintenance"):
            self.service.plan(TARGET["tag"])
        with self.assertRaisesRegex(ValueError, "maintenance"):
            self.service.apply(planned["planId"])
        with self.assertRaisesRegex(ValueError, "maintenance"):
            self.service.recover(planned["planId"])

    def test_plan_cannot_be_reused_after_installed_release_changes(self):
        planned = self.service.plan(TARGET["tag"])
        with mock.patch.object(self.service, "current_manifest", return_value=TARGET):
            with self.assertRaisesRegex(ValueError, "changed since the update plan"):
                self.service.apply(planned["planId"])
        self.assertIsNone(SERVICE.read_private(self.service.job_file))

    def test_failed_transaction_reports_verified_rollback(self):
        planned = self.service.plan(TARGET["tag"])

        def fail_after_rollback(root, current, target, context, snapshot):
            SERVICE.write_private(SERVICE.UPDATE.journal_path(snapshot), {"stage": "rolled-back"})
            raise RuntimeError("synthetic start failure")

        with mock.patch.object(SERVICE.UPDATE, "apply_update", side_effect=fail_after_rollback):
            _, launch = self.service.apply(planned["planId"])
            launch()
            job = self.wait_for_job()
        self.assertEqual(job["state"], "rolled-back")
        self.assertEqual(job["message"], "The previous Orbis release was restored.")

    def test_plan_expires_and_state_directory_must_be_private(self):
        planned = self.service.plan(TARGET["tag"])
        path = self.state / f"plan-{planned['planId']}.json"
        record = SERVICE.read_private(path)
        record["createdAt"] -= SERVICE.PLAN_TTL_SECONDS + 1
        SERVICE.write_private(path, record)
        with self.assertRaisesRegex(ValueError, "expired"):
            self.service.apply(planned["planId"])
        self.state.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "private"):
            SERVICE.HostService(self.root, "test-daemon", self.snapshots, self.state)

    def test_interrupted_update_can_recover_the_recorded_transaction(self):
        planned = self.service.plan(TARGET["tag"])
        job = {
            "schema": "orbis.host-service-job.v1",
            "id": planned["planId"],
            "state": "interrupted",
            "targetTag": TARGET["tag"],
            "startedAt": time.time(),
            "snapshot": str(self.snapshots / f"orbis-{TARGET['tag']}-{planned['planId']}"),
            "current": CURRENT,
            "target": TARGET,
        }
        SERVICE.write_private(self.service.job_file, job)
        with self.assertRaisesRegex(ValueError, "resolve the previous host update"):
            self.service.plan(TARGET["tag"])
        with mock.patch.object(SERVICE.UPDATE, "read_journal", return_value={"stage": "staged"}), mock.patch.object(
            SERVICE.UPDATE, "recover", return_value={"result": "rolled-back"}
        ) as recover:
            accepted, launch = self.service.recover(planned["planId"])
            self.assertEqual(accepted["state"], "recovering")
            launch()
            result = self.wait_for_job()
        self.assertEqual(result["state"], "rolled-back")
        self.assertEqual(recover.call_args.args[4], Path(job["snapshot"]))

    def test_status_reconciles_completed_transaction_after_service_restart(self):
        planned = self.service.plan(TARGET["tag"])
        snapshot = self.snapshots / f"orbis-{TARGET['tag']}-{planned['planId']}"
        SERVICE.write_private(
            self.service.job_file,
            {
                "schema": "orbis.host-service-job.v1",
                "id": planned["planId"],
                "state": "running",
                "targetTag": TARGET["tag"],
                "startedAt": time.time(),
                "snapshot": str(snapshot),
                "current": CURRENT,
                "target": TARGET,
            },
        )
        restarted = SERVICE.HostService(self.root, "test-daemon", self.snapshots, self.state)
        saved = {
            "tag": TARGET["tag"],
            "digest": TARGET["digest"],
            "root": str(self.root),
            "dockerContext": "test-daemon",
            "files": {
                name: SERVICE.HOST.file_digest(self.root / name)
                for name in ("docker-compose.yml", ".env", "user-config/tipi-compose.yml", "orbis-compose.yml")
            },
        }
        with mock.patch.object(SERVICE.HOST, "saved_state", return_value=saved), mock.patch.object(
            SERVICE.HOST,
            "current_core",
            return_value={"state": "running", "health": "healthy", "image": f"{TARGET['image']}@{TARGET['digest']}"},
        ), mock.patch.object(SERVICE, "read_private", wraps=SERVICE.read_private) as read:
            SERVICE.write_private(SERVICE.UPDATE.journal_path(snapshot), {"stage": "complete"})
            status = restarted.status()
        self.assertTrue(read.called)
        self.assertEqual(status["job"]["state"], "complete")
        self.assertTrue(status["imageMatches"])

    def test_http_only_accepts_fixed_paths_and_one_tag_field(self):
        socket_path = Path(self.temp.name) / "service.sock"
        server = SERVICE.UnixHTTPServer(str(socket_path), SERVICE.Handler)
        server.service = self.service
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def request(method: str, path: str, data: dict | None = None):
            body = json.dumps(data).encode() if data is not None else b""
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(str(socket_path))
            message = f"{method} {path} HTTP/1.0\r\nHost: localhost\r\nContent-Length: {len(body)}\r\n\r\n".encode() + body
            client.sendall(message)
            result = bytearray()
            while block := client.recv(4096):
                result.extend(block)
            client.close()
            header, payload = bytes(result).split(b"\r\n\r\n", 1)
            return int(header.split(b" ")[1]), json.loads(payload)

        self.assertEqual(request("GET", "/v1/unknown")[0], 404)
        self.assertEqual(request("POST", "/v1/plan", {"tag": TARGET["tag"], "command": "rm"})[0], 409)
        status, result = request("POST", "/v1/plan", {"tag": TARGET["tag"]})
        self.assertEqual(status, 200)
        self.assertEqual(result["targetTag"], TARGET["tag"])


if __name__ == "__main__":
    unittest.main()
