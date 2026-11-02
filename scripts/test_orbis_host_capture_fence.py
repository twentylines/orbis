import copy
import json
import os
import sys
import signal
import unittest
from unittest import mock

import test_orbis_host_controller_publication as PUBLICATION

SERVICE = PUBLICATION.SERVICE


class CaptureFenceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = PUBLICATION.ControllerPublicationTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.service = self.fixture.service
        receipt = self.fixture.prepare()
        self.request = {**self.fixture.request, "preparationSha256": receipt["preparationSha256"], "clientKey": "9" * 64}
        self.addCleanup(self.close_fence)

    def close_fence(self):
        if self.service.capture_fence_fd is not None:
            os.close(self.service.capture_fence_fd)
            self.service.capture_fence_fd = None

    def acquire(self):
        return self.service.acquire_capture_fence(self.request)

    def test_real_flock_and_persistent_marker_block_cli_and_service_mutations(self):
        result = self.acquire()
        token = result["token"]
        lock = os.open(self.service.root.parent / f".{self.service.root.name}.orbis-host.lock", os.O_RDWR)
        try:
            with self.assertRaises(BlockingIOError):
                SERVICE.HOST.fcntl.flock(lock, SERVICE.HOST.fcntl.LOCK_EX | SERVICE.HOST.fcntl.LOCK_NB)
        finally:
            os.close(lock)
        raw = SERVICE.HOST.capture_fence_path(self.service.root).read_text()
        self.assertNotIn(token, raw)
        for action in (self.service.require_restart_clear, self.service.require_idle_core,
                       lambda: self.service.plan("v0.5.0-beta.2"), lambda: self.service.apply("invalid"),
                       lambda: self.service.recover("invalid"), lambda: self.service.package_plan([]),
                       lambda: self.service.run_capture_mutation(mock.Mock())):
            with self.subTest(action=action), self.assertRaisesRegex(ValueError, "capture"):
                action()
        with self.assertRaises(ValueError):
            with SERVICE.HOST.host_lock(self.service.root):
                self.fail("CLI admitted during capture")
        capture = self.service.capture_controller_config(self.request["pointId"], self.request["controllerId"], self.request["imageId"], token)
        self.assertEqual(capture["configurationSetSha256"], self.request["configurationSetSha256"])
        with self.assertRaises(ValueError):
            self.fixture.fixture.capture()
        self.service.maintain_capture_fence("release", token)
        with SERVICE.HOST.host_lock(self.service.root):
            pass
        self.assertFalse(SERVICE.HOST.capture_fence_path(self.service.root).exists())

    def test_unprepared_forged_replayed_or_changed_generation_is_rejected(self):
        self.service.prepared_capture = None
        with self.assertRaises(ValueError):
            self.acquire()
        self.fixture.prepare()
        for key in self.request:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.service.acquire_capture_fence({**self.request, key: "forged"})
        result = self.acquire()
        self.assertEqual(self.acquire(), result)
        with self.assertRaises(ValueError):
            self.service.acquire_capture_fence({**self.request, "clientKey": "8" * 64})
        self.service.maintain_capture_fence("release", result["token"])
        with self.assertRaises(ValueError):
            self.acquire()

    def test_renewal_rechecks_generation_and_expiry_stays_fail_closed(self):
        result = self.acquire()
        token = result["token"]
        with mock.patch.object(SERVICE.time, "time", return_value=result["expiresAt"] - 5):
            renewed = self.service.maintain_capture_fence("renew", token)
        self.assertGreater(renewed["expiresAt"], result["expiresAt"])
        with mock.patch.object(SERVICE.time, "time", return_value=renewed["expiresAt"] + 1):
            with self.assertRaises(ValueError):
                self.service.maintain_capture_fence("renew", token)
            with self.assertRaises(ValueError):
                self.service.capture_controller_config(self.request["pointId"], self.request["controllerId"], self.request["imageId"], token)
            with self.assertRaises(ValueError):
                self.service.require_restart_clear()
            self.service.maintain_capture_fence("release", token)

    def test_config_tamper_does_not_clear_protected_fence(self):
        token = self.acquire()["token"]
        path = self.service.root / ".env"
        original = path.read_bytes()
        path.write_bytes(b"CHANGED_FIXTURE=1\n")
        for action in ("renew", "release"):
            with self.subTest(action=action), self.assertRaises(ValueError):
                self.service.maintain_capture_fence(action, token)
        self.assertTrue(SERVICE.HOST.capture_fence_path(self.service.root).exists())
        path.write_bytes(original)
        # Restoring bytes does not recreate the prior metadata generation.
        with self.assertRaises(ValueError):
            self.service.maintain_capture_fence("release", token)

    def test_restart_never_ignores_stale_fence_and_requires_explicit_token_bound_reconcile(self):
        token = self.acquire()["token"]
        self.close_fence()
        restarted = SERVICE.HostService(self.service.root, self.service.context, self.service.snapshots, self.service.state_dir)
        with self.assertRaises(ValueError):
            restarted.require_restart_clear()
        with self.assertRaises(ValueError):
            restarted.maintain_capture_fence("renew", token)
        with self.assertRaises(ValueError):
            restarted.maintain_capture_fence("release", token)
        with self.assertRaises(ValueError):
            restarted.maintain_capture_fence("reconcile", "0" * 64)
        restarted.maintain_capture_fence("reconcile", token)
        with SERVICE.HOST.host_lock(restarted.root):
            pass

    def test_symlink_marker_and_wrong_token_are_rejected_without_following(self):
        token = self.acquire()["token"]
        with self.assertRaises(ValueError):
            self.service.maintain_capture_fence("release", "0" * 64)
        marker = SERVICE.HOST.capture_fence_path(self.service.root)
        other = self.service.state_dir / "other.json"
        marker.rename(other)
        marker.symlink_to(other)
        with self.assertRaises(OSError):
            self.service.maintain_capture_fence("renew", token)
        with self.assertRaises(ValueError):
            self.service.require_restart_clear()
        marker.unlink()
        other.rename(marker)
        self.service.maintain_capture_fence("release", token)

    def test_lost_acquire_response_retries_same_private_key_and_cleanup_is_idempotent(self):
        lost = self.acquire()
        marker = SERVICE.HOST.capture_fence_path(self.service.root).read_bytes()
        retried = self.acquire()
        self.assertEqual(lost, retried)
        self.assertEqual(marker, SERVICE.HOST.capture_fence_path(self.service.root).read_bytes())
        self.service.maintain_capture_fence("release", self.request["clientKey"])
        self.assertEqual(self.service.maintain_capture_fence("release", self.request["clientKey"]), {"version": 1, "released": True})

    def test_durable_recovery_must_match_every_reviewed_binding_before_releasing(self):
        token = self.acquire()["token"]
        expected = {key: value for key, value in self.request.items() if key != "clientKey"}
        marker = SERVICE.HOST.capture_fence_path(self.service.root)
        before = marker.read_bytes()
        for key in expected:
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.service.maintain_capture_fence("release", token, {**expected, key: "foreign"})
            self.assertEqual(marker.read_bytes(), before)
        self.service.maintain_capture_fence("release", token, expected)
        self.assertFalse(marker.exists())

    def test_bound_crash_cleanup_allows_only_controller_start_time_change_not_configuration_drift(self):
        token = self.acquire()["token"]
        expected = {key: value for key, value in self.request.items() if key != "clientKey"}
        self.fixture.fixture.identity["startedAt"] = "2026-11-01T12:00:00Z"
        with self.assertRaises(ValueError):
            self.service.maintain_capture_fence("renew", token)
        with self.assertRaises(ValueError):
            self.service.maintain_capture_fence("release", token)
        self.service.maintain_capture_fence("release", token, expected)
        self.assertFalse(SERVICE.HOST.capture_fence_path(self.service.root).exists())

    def test_private_http_routes_bound_bodies_and_hide_diagnostics(self):
        handler = object.__new__(SERVICE.Handler)
        handler.server = mock.Mock(service=self.service)
        handler.send_json = mock.Mock()
        handler.path = "/v1/controller-capture-fence/capability"
        handler.do_GET()
        self.assertEqual(handler.send_json.call_args.args, (200, {"version": 1, "capability": "controller-capture-fence.v1"}))
        handler.path = "/v1/controller-capture-fence/acquire"
        handler.body = mock.Mock(return_value={**self.request, "root": "/caller-controlled"})
        handler.do_POST()
        self.assertEqual(handler.send_json.call_args.args[0], 409)
        handler.body.assert_called_once_with(1024)
        self.assertNotIn("caller-controlled", json.dumps(handler.send_json.call_args.args))
        handler.path = "/v1/controller-capture-fence/renew"
        handler.body.return_value = {"token": "private-unknown-token"}
        handler.do_POST()
        self.assertEqual(handler.send_json.call_args.args[0], 409)
        self.assertNotIn("private-unknown-token", json.dumps(handler.send_json.call_args.args))

    def test_durable_marker_write_failure_releases_flock_but_retains_fail_closed_state(self):
        with mock.patch.object(self.service, "_sync_capture_fence_directory", side_effect=OSError("fixture disk sync failure")):
            with self.assertRaises(OSError):
                self.acquire()
        self.assertIsNone(self.service.capture_fence_fd)
        self.assertTrue(SERVICE.HOST.capture_fence_path(self.service.root).exists())
        with self.assertRaises(ValueError):
            self.service.require_restart_clear()


def serve_journal_fixture(point_id):
    fixture = PUBLICATION.ControllerPublicationTests()
    fixture.setUp()
    server = None
    def stop(*_): raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGALRM, stop)
    signal.alarm(20)
    try:
        fixture.fixture.point = point_id
        baseline = fixture.fixture.capture()
        fixture.request = {"pointId": point_id, "controllerId": fixture.fixture.controller,
                           "imageId": fixture.fixture.image, "configurationSetSha256": baseline["configurationSetSha256"]}
        receipt = fixture.prepare()
        expected = {"configuration": {**baseline, "files": [{key: value for key, value in item.items() if key != "data"}
                                                              for item in baseline["files"]]},
                    "publication": fixture.release, "platform": json.loads(fixture.verified.platform_bytes)}
        runtime = fixture.fixture.base / "runtime"
        runtime.mkdir(mode=0o700)
        endpoint = runtime / "journal.sock"
        class Handler(SERVICE.Handler):
            def do_POST(self):
                if self.path == "/__fixture_restart":
                    old = self.server.service
                    if old.capture_fence_fd is not None:
                        os.close(old.capture_fence_fd)
                        old.capture_fence_fd = None
                    fixture.fixture.identity["startedAt"] = "2026-11-01T12:00:00Z"
                    self.server.service = SERVICE.HostService(old.root, old.context, old.snapshots, old.state_dir)
                    self.send_json(200, {"restarted": True})
                    return
                super().do_POST()
        server = SERVICE.UnixHTTPServer(str(endpoint), Handler)
        server.service = fixture.service
        endpoint.chmod(0o600)
        print(json.dumps({"socket": str(endpoint), "expected": expected, "receipt": receipt}), flush=True)
        server.serve_forever(poll_interval=0.05)
    finally:
        signal.alarm(0)
        if server:
            if server.service.capture_fence_fd is not None:
                os.close(server.service.capture_fence_fd)
                server.service.capture_fence_fd = None
            server.server_close()
        fixture.doCleanups()


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--serve-journal-fixture":
        serve_journal_fixture(sys.argv[2])
    else:
        unittest.main()
