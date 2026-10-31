import base64
import hashlib
import importlib.util
import json
import os
import socket
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location("host_controller_config_fixture", Path(__file__).with_name("orbis-host-service.py"))
SERVICE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVICE)


class ControllerConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "installation"
        self.state = self.base / "private-state"
        self.snapshots = self.base / "snapshots"
        for directory in (self.root, self.state, self.snapshots):
            directory.mkdir(mode=0o700)
        self.values = {"docker-compose.yml": b"services: {}\n", ".env": b"FIXTURE_PRIVATE_VALUE=not-a-real-secret\n", "orbis-compose.yml": b"services: {}\n"}
        for name, data in self.values.items():
            (self.root / name).write_bytes(data)
            (self.root / name).chmod(0o600)
        self.enroll()
        self.service = SERVICE.HostService(self.root, "fixture", self.snapshots, self.state)
        self.point = str(uuid.uuid4())
        self.controller = "a" * 64
        self.image = "sha256:" + "b" * 64
        self.identity = {"id": self.controller, "imageId": self.image, "imageReference": "ghcr.io/twentylines/orbis@sha256:" + "c" * 64,
                         "project": "runtipi", "service": "runtipi", "workingDirectory": str(self.root), "running": True,
                         "restarting": False, "paused": False, "health": "healthy", "startedAt": "2026-10-31T00:00:00Z"}
        self.docker_patch = mock.patch.object(SERVICE.HOST, "docker", side_effect=lambda *_: mock.Mock(returncode=0, stdout=json.dumps(self.identity)))
        self.docker = self.docker_patch.start()
        self.addCleanup(self.docker_patch.stop)

    def enroll(self):
        names = [name for name in SERVICE.CONTROLLER_CONFIG_FILES if name != "orbis-host-compose.yml" or (self.root / name).exists()]
        value = {"schema": "orbis.host.v1", "root": str(self.root), "dockerContext": "fixture", "tag": "v0.5.0-beta.1",
                 "digest": "sha256:" + "c" * 64,
                 "files": {name: hashlib.sha256((self.root / name).read_bytes()).hexdigest() if (self.root / name).exists() else None for name in names}}
        SERVICE.HOST.write_state(self.root, value)

    def capture(self):
        return self.service.capture_controller_config(self.point, self.controller, self.image)

    def test_fixed_files_bytes_metadata_absence_and_point_controller_digest_are_bound(self):
        result = self.capture()
        self.assertEqual(result["pointId"], self.point)
        self.assertEqual(result["controller"]["id"], self.controller)
        self.assertEqual(result["controller"]["imageId"], self.image)
        self.assertEqual([item["path"] for item in result["files"]], list(SERVICE.CONTROLLER_CONFIG_FILES))
        for item in result["files"]:
            if item["path"] in self.values:
                self.assertEqual(base64.b64decode(item["data"], validate=True), self.values[item["path"]])
                self.assertEqual(item["bytes"], len(self.values[item["path"]]))
                self.assertEqual(item["mode"], 0o600)
                self.assertEqual(item["uid"], os.geteuid())
                self.assertEqual(item["gid"], (self.root / item["path"]).stat().st_gid)
            else:
                self.assertEqual(item, {"path": item["path"], "present": False})
        descriptor = {key: value for key, value in result.items() if key != "configurationSetSha256"}
        descriptor["files"] = [{key: value for key, value in item.items() if key != "data"} for item in result["files"]]
        self.assertEqual(result["configurationSetSha256"], hashlib.sha256(b"orbis.controller-config.v1\n" + json.dumps(descriptor, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
        self.assertNotIn(str(self.root), json.dumps(result))
        self.assertTrue(all(call.args[1][0] == "inspect" and "compose" not in call.args[1] for call in self.docker.call_args_list))

    def test_optional_files_are_captured_only_from_the_fixed_protected_directory(self):
        (self.root / "user-config").mkdir(mode=0o700)
        for name in ("user-config/tipi-compose.yml", "orbis-host-compose.yml"):
            (self.root / name).write_bytes(b"owned optional fixture\n")
            (self.root / name).chmod(0o640)
        self.enroll()
        self.assertTrue(all(item["present"] for item in self.capture()["files"]))

    def test_no_ordinary_digest_status_plan_or_job_reconciliation_is_called(self):
        with mock.patch.object(SERVICE.HOST, "file_digest", side_effect=AssertionError("unbounded read")), \
             mock.patch.object(self.service, "status", side_effect=AssertionError("reconciliation")), \
             mock.patch.object(self.service, "current_manifest", side_effect=AssertionError("compose")), \
             mock.patch.object(SERVICE.PLAN, "plan", side_effect=AssertionError("compose")):
            self.capture()

    def test_oversized_fixed_file_is_rejected_before_any_unbounded_read_or_docker(self):
        (self.root / ".env").write_bytes(b"x" * (SERVICE.CONTROLLER_CONFIG_FILE_LIMIT + 1))
        with mock.patch.object(SERVICE.HOST, "file_digest", side_effect=AssertionError("unbounded read")):
            with self.assertRaises(ValueError):
                self.capture()
        self.docker.assert_not_called()

    def test_symlinks_hardlinks_fifo_and_writable_files_are_rejected_without_following_them(self):
        file = self.root / ".env"
        for kind in ("symlink", "hardlink", "fifo", "writable"):
            with self.subTest(kind=kind):
                file.unlink()
                outside = self.base / f"outside-{kind}"
                outside.write_bytes(self.values[".env"])
                outside.chmod(0o600)
                if kind == "symlink": file.symlink_to(outside)
                elif kind == "hardlink": os.link(outside, file)
                elif kind == "fifo": os.mkfifo(file, 0o600)
                else:
                    file.write_bytes(self.values[".env"])
                    file.chmod(0o666)
                with self.assertRaises((ValueError, OSError)):
                    self.capture()
                self.assertEqual(outside.read_bytes(), self.values[".env"])
        self.docker.assert_not_called()

    def test_optional_user_config_alias_is_rejected_even_when_its_file_is_absent(self):
        outside = self.base / "outside-directory"
        outside.mkdir(mode=0o700)
        (self.root / "user-config").symlink_to(outside, target_is_directory=True)
        with self.assertRaises((OSError, ValueError)):
            self.capture()
        self.docker.assert_not_called()

    def test_file_replacement_or_new_optional_entry_during_inspection_is_rejected(self):
        for kind in ("replace", "optional"):
            with self.subTest(kind=kind):
                def inspect(*_):
                    if kind == "replace":
                        file = self.root / ".env"
                        data = file.read_bytes()
                        file.unlink()
                        file.write_bytes(data)
                        file.chmod(0o600)
                    else:
                        (self.root / "orbis-host-compose.yml").write_bytes(b"new optional generation")
                    return mock.Mock(returncode=0, stdout=json.dumps(self.identity))
                self.docker.side_effect = inspect
                with self.assertRaises(ValueError): self.capture()
                (self.root / "orbis-host-compose.yml").unlink(missing_ok=True)

    def test_wrong_enrollment_and_controller_identity_fail_closed(self):
        (self.root / ".env").write_bytes(b"unreviewed generation")
        with self.assertRaises(ValueError): self.capture()
        self.docker.assert_not_called()
        (self.root / ".env").write_bytes(self.values[".env"])
        for field, value in (("id", "d" * 64), ("imageId", "sha256:" + "e" * 64), ("project", "unrelated"),
                             ("service", "unrelated"), ("workingDirectory", str(self.root / ".." / self.root.name)),
                             ("running", False), ("health", "unhealthy"), ("paused", True), ("restarting", True)):
            with self.subTest(field=field):
                original = self.identity[field]
                self.identity[field] = value
                with self.assertRaises(ValueError): self.capture()
                self.identity[field] = original

    def test_controller_restart_between_pre_and_post_probes_is_rejected(self):
        self.docker.side_effect = [mock.Mock(returncode=0, stdout=json.dumps(self.identity)),
                                   mock.Mock(returncode=0, stdout=json.dumps({**self.identity, "startedAt": "new generation"}))]
        with self.assertRaises(ValueError): self.capture()

    def test_pending_operations_are_not_reconciled_and_capture_does_not_take_over_locks(self):
        for name, state in (("job.json", "interrupted"), ("package-job.json", "failed"), ("restart-job.json", "restarting")):
            file = self.state / name
            SERVICE.write_private(file, {"state": state})
            before = file.read_bytes()
            with self.assertRaises(ValueError): self.capture()
            self.assertEqual(file.read_bytes(), before)
            file.unlink()
        SERVICE.write_private(self.service.job_file, {})
        with self.assertRaises(ValueError): self.capture()
        self.service.job_file.unlink()
        self.service.lock.acquire()
        try:
            with self.assertRaises(ValueError): self.capture()
        finally: self.service.lock.release()
        with SERVICE.HOST.host_lock(self.root):
            with self.assertRaises(ValueError): self.capture()
        self.docker.assert_not_called()

    def test_timeout_releases_both_locks_and_capture_context_without_changing_ordinary_run(self):
        self.docker_patch.stop()
        with mock.patch.object(SERVICE.HOST.subprocess, "run", side_effect=subprocess.TimeoutExpired("fixed-inspection", 1, output="PRIVATE_FIXTURE")):
            with self.assertRaises(subprocess.TimeoutExpired): self.capture()
        self.assertIsNone(SERVICE.HOST.CAPTURE_READ_DEADLINE.get())
        self.assertIsNone(SERVICE.HOST.LOCK_DESCRIPTOR.get())
        self.assertTrue(self.service.lock.acquire(blocking=False))
        self.service.lock.release()
        with SERVICE.HOST.host_lock(self.root): pass
        with mock.patch.object(SERVICE.HOST.subprocess, "run", return_value=mock.Mock(returncode=0)) as run:
            SERVICE.HOST.run(["fixed-read-fixture"], self.root)
            self.assertNotIn("timeout", run.call_args.kwargs)

    def test_http_route_only_accepts_bound_identity_and_never_returns_payload_in_errors(self):
        handler = object.__new__(SERVICE.Handler)
        handler.path = "/v1/controller-config/capture"
        handler.server = mock.Mock(service=self.service)
        handler.body = mock.Mock(return_value={"pointId": self.point, "controllerId": self.controller, "imageId": self.image, "root": "/not-allowed"})
        handler.send_json = mock.Mock()
        handler.do_POST()
        self.assertEqual(handler.send_json.call_args.args[0], 409)
        handler.body.return_value.pop("root")
        with mock.patch.object(self.service, "capture_controller_config", side_effect=ValueError("PRIVATE_FIXTURE")):
            handler.do_POST()
        self.assertNotIn("PRIVATE_FIXTURE", json.dumps(handler.send_json.call_args.args))

    def test_real_unix_handler_connection_captures_privately_and_ordinary_status_has_no_payload(self):
        socket_path = self.base / "host.sock"
        server = SERVICE.UnixHTTPServer(str(socket_path), SERVICE.Handler)
        server.service = self.service
        socket_path.chmod(0o600)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        def request(method, route, body=None):
            payload = json.dumps(body).encode() if body is not None else b""
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.settimeout(3)
                client.connect(str(socket_path))
                client.sendall(f"{method} {route} HTTP/1.0\r\nHost: localhost\r\nContent-Length: {len(payload)}\r\n\r\n".encode() + payload)
                response = bytearray()
                while block := client.recv(65536): response.extend(block)
            header, data = response.split(b"\r\n\r\n", 1)
            return int(header.split(b" ")[1]), json.loads(data)
        status, result = request("POST", "/v1/controller-config/capture", {"pointId": self.point, "controllerId": self.controller, "imageId": self.image})
        self.assertEqual(status, 200)
        self.assertEqual(base64.b64decode(result["files"][1]["data"]), self.values[".env"])
        self.assertEqual(request("GET", "/v1/controller-config/capture")[0], 404)
        self.assertEqual(request("POST", "/v1/controller-config/capture?path=.env", {})[0], 404)
        with mock.patch.object(SERVICE.HOST, "current_core", return_value={"state": "running", "health": "healthy", "image": self.identity["imageReference"]}):
            ordinary = request("GET", "/v1/status")[1]
        self.assertIn("controller-config.v1", ordinary["capabilities"])
        self.assertNotIn("files", ordinary)
        self.assertNotIn("rootIdentity", ordinary)
        self.assertNotIn(result["files"][1]["data"], json.dumps(ordinary))


if __name__ == "__main__":
    if sys.argv[1:] == ["--serve-client-fixture"]:
        fixture = ControllerConfigTests("test_fixed_files_bytes_metadata_absence_and_point_controller_digest_are_bound")
        fixture.setUp()
        server = None
        def stop_fixture(*_): raise SystemExit(0)
        signal.signal(signal.SIGTERM, stop_fixture)
        signal.signal(signal.SIGALRM, stop_fixture)
        signal.alarm(5)
        try:
            runtime = fixture.base / "runtime"
            runtime.mkdir(mode=0o700)
            endpoint = runtime / "client-bridge.sock"
            server = SERVICE.UnixHTTPServer(str(endpoint), SERVICE.Handler)
            server.service = fixture.service
            endpoint.chmod(0o600)
            print(json.dumps({"socket": str(endpoint), "pointId": fixture.point, "controllerId": fixture.controller, "imageId": fixture.image}), flush=True)
            server.serve_forever(poll_interval=0.05)
        finally:
            signal.alarm(0)
            if server: server.server_close()
            fixture.doCleanups()
    else:
        unittest.main()
