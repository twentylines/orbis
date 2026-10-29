import importlib.util
import json
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import uuid
from contextlib import ExitStack, nullcontext
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


class DiscoveryRoutesTests(unittest.TestCase):
    def handler(self, path, body=None):
        handler = object.__new__(SERVICE.Handler)
        handler.path = path
        handler.server = mock.Mock()
        handler.send_json = mock.Mock()
        handler.body = mock.Mock(return_value=body)
        return handler

    def test_status_and_interface_routes_are_read_only(self):
        for path, method in [("/v1/discovery/status", "status"), ("/v1/discovery/interfaces", "inventory")]:
            handler = self.handler(path)
            getattr(handler.server.service.discovery, method).return_value = {"available": False}
            handler.do_GET()
            handler.send_json.assert_called_once_with(200, {"available": False})
            handler.server.service.discovery.advertise.assert_not_called()

    def test_advertisement_requires_exact_nonsecret_fields_and_disable_is_explicit(self):
        fields = {"interface": "eth0", "origin": "https://source.example", "address": "192.168.50.10", "leaseSeconds": 120}
        handler = self.handler("/v1/discovery/advertise", fields)
        handler.do_POST()
        handler.server.service.discovery.advertise.assert_called_once_with("eth0", "https://source.example", "192.168.50.10", 120)
        handler = self.handler("/v1/discovery/advertise", {**fields, "pairingCode": "fixture-only"})
        handler.do_POST()
        handler.server.service.discovery.advertise.assert_not_called()
        self.assertFalse(handler.send_json.call_args.args[1]["available"])
        handler = self.handler("/v1/discovery/disable", {})
        handler.do_POST()
        handler.server.service.discovery.disable.assert_called_once()


class PlanReviewTimeTests(unittest.TestCase):
    def test_review_window_includes_its_boundaries_and_rejects_invalid_timestamps(self):
        with mock.patch.object(SERVICE.time, "time", return_value=900):
            for timestamp in (0, 450, 900):
                with self.subTest(timestamp=timestamp):
                    self.assertTrue(SERVICE.plan_is_current(timestamp, 900))
            for timestamp in (-0.01, 900.01, True, False, None, "900", float("nan"), float("inf"), -float("inf"), 10 ** 1000):
                with self.subTest(timestamp=timestamp):
                    self.assertFalse(SERVICE.plan_is_current(timestamp, 900))


class InstalledManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name).resolve()
        self.root, self.snapshots, self.state = (base / name for name in ("install", "snapshots", "state"))
        for directory in (self.root, self.snapshots, self.state):
            directory.mkdir(mode=0o700)
        for name, content in {
            "docker-compose.yml": "fixture\n",
            ".env": "TIPI_VERSION=4.10.1\n",
            "VERSION": "4.10.1\n",
            "orbis-compose.yml": SERVICE.HOST.STAGE.staged_content(CURRENT),
        }.items():
            (self.root / name).write_text(content)
        self.compose = mock.patch.object(SERVICE.PLAN, "plan", return_value={})
        self.compose.start()
        self.addCleanup(self.compose.stop)
        self.saved = SERVICE.HOST.installation_fingerprint(self.root, CURRENT, "test-daemon")
        SERVICE.HOST.write_state(self.root, self.saved)
        self.service = SERVICE.HostService(self.root, "test-daemon", self.snapshots, self.state)
        self.metadata = {
            "labels": {
                "org.opencontainers.image.source": "https://github.com/twentylines/orbis",
                "org.opencontainers.image.version": CURRENT["tag"],
                "org.opencontainers.image.revision": CURRENT["commit"],
            },
            "digests": [f"{CURRENT['image']}@{CURRENT['digest']}"],
        }

    def test_host_socket_override_is_part_of_the_enrollment_identity(self):
        override = self.root / "orbis-host-compose.yml"
        override.write_text('{"services":{"runtipi":{"environment":{"ORBIS_HOST_SOCKET":"/run/orbis/host.sock"}}}}')
        self.assertFalse(SERVICE.enrollment_matches(self.root, "test-daemon", self.saved))
        saved = SERVICE.HOST.installation_fingerprint(self.root, CURRENT, "test-daemon")
        self.assertTrue(SERVICE.enrollment_matches(self.root, "test-daemon", saved))
        override.write_text("operator changed the socket mount")
        self.assertFalse(SERVICE.enrollment_matches(self.root, "test-daemon", saved))

    def inspect_result(self):
        return mock.Mock(returncode=0, stdout=json.dumps(self.metadata))

    def test_archived_installed_release_uses_its_local_digest_and_original_build_identity(self):
        with mock.patch.object(SERVICE.HOST, "docker", return_value=self.inspect_result()) as docker, mock.patch.object(
            SERVICE.CHECK, "check", side_effect=AssertionError("installed identity must not require remote assets")
        ):
            self.assertEqual(self.service.current_manifest(), CURRENT)
        self.assertEqual(docker.call_args.args[0], "test-daemon")
        self.assertEqual(docker.call_args.args[1][-1], f"{CURRENT['image']}@{CURRENT['digest']}")
        self.assertEqual(docker.call_args.args[2], self.root)

    def test_target_release_still_requires_independent_verification(self):
        with mock.patch.object(SERVICE.HOST, "docker", return_value=self.inspect_result()), mock.patch.object(
            SERVICE, "manifest_for_tag", side_effect=ValueError("target release is not verified")
        ) as target:
            with self.assertRaisesRegex(ValueError, "target release is not verified"):
                self.service.plan(TARGET["tag"])
        target.assert_called_once_with(TARGET["tag"])
        self.assertEqual(list(self.state.iterdir()), [])

    def test_foreign_missing_or_changed_image_identity_is_rejected(self):
        mutations = [
            lambda value: value["labels"].update({"org.opencontainers.image.source": "https://github.com/example/orbis"}),
            lambda value: value["labels"].update({"org.opencontainers.image.version": TARGET["tag"]}),
            lambda value: value["labels"].update({"org.opencontainers.image.revision": "not-a-commit"}),
            lambda value: value["labels"].update({"org.opencontainers.image.revision": "d" * 40}),
            lambda value: value.update(digests=[]),
            lambda value: value.update(digests=[f"{TARGET['image']}@{TARGET['digest']}"]),
            lambda value: value.update(labels=None),
            lambda value: value.update(digests=None),
        ]
        for change in mutations:
            with self.subTest(change=change):
                metadata = json.loads(json.dumps(self.metadata))
                change(metadata)
                with mock.patch.object(SERVICE.HOST, "docker", return_value=mock.Mock(returncode=0, stdout=json.dumps(metadata))):
                    with self.assertRaises(ValueError):
                        self.service.current_manifest()

    def test_changed_enrollment_or_configuration_is_rejected_before_image_inspection(self):
        for name in ("docker-compose.yml", ".env", "orbis-compose.yml"):
            with self.subTest(name=name):
                file = self.root / name
                original = file.read_text()
                file.write_text(original + "changed\n")
                try:
                    with mock.patch.object(SERVICE.HOST, "docker") as docker:
                        with self.assertRaisesRegex(ValueError, "not enrolled"):
                            self.service.current_manifest()
                        docker.assert_not_called()
                finally:
                    file.write_text(original)

    def test_missing_image_and_malformed_metadata_fail_without_relaying_docker_output(self):
        for result in (
            mock.Mock(returncode=1, stdout="SECRET_MARKER", stderr="SECRET_MARKER"),
            mock.Mock(returncode=0, stdout="SECRET_MARKER"),
            mock.Mock(returncode=0, stdout="[]"),
        ):
            with self.subTest(result=result):
                with mock.patch.object(SERVICE.HOST, "docker", return_value=result):
                    with self.assertRaises((ValueError, RuntimeError)) as caught:
                        self.service.current_manifest()
                    self.assertNotIn("SECRET_MARKER", str(caught.exception))


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
        SERVICE.save_channel(self.root, "nightly", str(uuid.uuid4()))
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
        self.healthy = mock.patch.object(self.service, "require_healthy_core")
        self.healthy.start()
        self.addCleanup(self.healthy.stop)

    def wait_for_job(self):
        for _ in range(100):
            record = SERVICE.read_private(self.service.job_file)
            if record and record["state"] not in {"running", "recovering"}:
                return record
            time.sleep(0.01)
        self.fail("background update did not finish")

    def restart_host(self):
        stack = ExitStack()
        stack.enter_context(mock.patch.object(SERVICE.Path, "is_dir", return_value=True))
        stack.enter_context(mock.patch.object(SERVICE.os, "access", return_value=True))
        stack.enter_context(mock.patch.object(SERVICE, "boot_id", return_value="00000000-0000-4000-8000-000000000001"))
        stack.enter_context(mock.patch.object(SERVICE, "package_locks", side_effect=nullcontext))
        return stack

    def test_restart_review_alone_never_requests_a_reboot(self):
        with self.restart_host(), mock.patch.object(SERVICE.subprocess, "run") as command:
            plan = self.service.restart_plan()
            self.assertGreater(plan["expiresAt"], time.time())
            self.assertIsNone(self.service.restart_status()["job"])
            command.assert_not_called()

    def test_restart_uses_one_fixed_command_and_is_completed_only_on_a_new_boot(self):
        requested = threading.Event()
        def reboot(*args, **kwargs):
            requested.set()
            return mock.Mock(returncode=0)
        with self.restart_host(), mock.patch.object(SERVICE.subprocess, "run", side_effect=reboot) as command:
            plan = self.service.restart_plan()
            result, launch = self.service.restart_apply(plan["planId"])
            self.assertEqual(result, {"jobId": plan["planId"], "state": "restarting"})
            command.assert_not_called()
            launch()
            self.assertTrue(requested.wait(2))
            self.assertEqual(command.call_args.args[0], ["/usr/bin/systemctl", "reboot", "--no-block"])
            self.assertEqual(command.call_count, 1)
            restarted_helper = SERVICE.HostService(self.root, "test-daemon", self.snapshots, self.state)
            self.assertEqual(restarted_helper.restart_status()["job"]["state"], "restarting")
            with self.assertRaisesRegex(ValueError, "server is restarting"):
                restarted_helper.plan(TARGET["tag"])
            with self.assertRaisesRegex(ValueError, "server is restarting"):
                self.service.restart_apply(plan["planId"])
            with mock.patch.object(SERVICE, "boot_id", return_value="00000000-0000-4000-8000-000000000002"):
                self.assertEqual(restarted_helper.restart_status()["job"]["state"], "complete")

    def test_restart_refuses_stale_changed_and_used_review_without_running_anything(self):
        with self.restart_host(), mock.patch.object(SERVICE.subprocess, "run") as command:
            for mutation in ("expired", "future", "bootId", "root", "dockerContext", "consumedAt"):
                with self.subTest(mutation=mutation):
                    planned = self.service.restart_plan()
                    file = self.state / f"restart-plan-{planned['planId']}.json"
                    record = SERVICE.read_private(file)
                    if mutation == "expired":
                        record["createdAt"] = time.time() - SERVICE.RESTART_PLAN_TTL_SECONDS - 1
                    elif mutation == "future":
                        record["createdAt"] = time.time() + 30
                    else:
                        record[mutation] = "changed"
                    SERVICE.write_private(file, record)
                    with self.assertRaisesRegex(ValueError, "restart plan is missing, changed"):
                        self.service.restart_apply(planned["planId"])
            command.assert_not_called()
            self.assertIsNone(SERVICE.read_private(self.service.restart_job_file))

    def test_restart_blocks_conflicting_jobs_maintenance_and_host_lock(self):
        with self.restart_host(), mock.patch.object(SERVICE.subprocess, "run") as command:
            for target, states in ((self.service.job_file, ("running", "recovering", "interrupted")), (self.service.package_job_file, ("queued", "running", "failed", "interrupted"))):
                for state in states:
                    with self.subTest(file=target.name, state=state):
                        SERVICE.write_private(target, {"state": state})
                        with self.assertRaises(ValueError):
                            self.service.restart_plan()
                        target.unlink()
            SERVICE.write_private(self.service.maintenance_file, {})
            with self.assertRaisesRegex(ValueError, "maintenance"):
                self.service.restart_plan()
            self.service.maintenance_file.unlink()
            with SERVICE.HOST.host_lock(self.root):
                with self.assertRaisesRegex(ValueError, "another Orbis host operation"):
                    self.service.restart_plan()
            command.assert_not_called()

    def test_pending_restart_blocks_all_new_core_and_package_writes(self):
        with self.restart_host():
            planned = self.service.restart_plan()
            self.service.restart_apply(planned["planId"])
            for operation in (
                lambda: self.service.plan(TARGET["tag"]), lambda: self.service.apply(planned["planId"]),
                lambda: self.service.recover(planned["planId"]), lambda: self.service.package_plan(["base-files"]),
                lambda: self.service.package_apply(planned["planId"]),
            ):
                with self.assertRaisesRegex(ValueError, "server is restarting"):
                    operation()

    def test_failed_restart_is_reported_and_consumed_review_cannot_be_replayed(self):
        with self.restart_host(), mock.patch.object(SERVICE.subprocess, "run", return_value=mock.Mock(returncode=1, stderr="SECRET")):
            planned = self.service.restart_plan()
            _, launch = self.service.restart_apply(planned["planId"])
            launch()
            for _ in range(100):
                job = self.service.restart_status()["job"]
                if job["state"] == "failed":
                    break
                time.sleep(0.01)
            self.assertEqual(job["state"], "failed")
            self.assertNotIn("SECRET", job["message"])
            with self.assertRaisesRegex(ValueError, "already used"):
                self.service.restart_apply(planned["planId"])

    def test_uncertain_systemd_request_stays_blocked_instead_of_allowing_an_update(self):
        with self.restart_host(), mock.patch.object(SERVICE.subprocess, "run", side_effect=SERVICE.subprocess.TimeoutExpired("systemctl", 10)):
            planned = self.service.restart_plan()
            _, launch = self.service.restart_apply(planned["planId"])
            launch()
            for _ in range(100):
                job = self.service.restart_status()["job"]
                if "could not be confirmed" in job["message"]:
                    break
                time.sleep(0.01)
            self.assertEqual(job["state"], "restarting")
            self.assertIn("could not be confirmed", job["message"])
            with self.assertRaisesRegex(ValueError, "server is restarting"):
                self.service.package_plan(["base-files"])

    def test_worker_rechecks_locks_after_the_response_before_requesting_restart(self):
        with self.restart_host(), mock.patch.object(SERVICE.subprocess, "run") as command:
            planned = self.service.restart_plan()
            _, launch = self.service.restart_apply(planned["planId"])
            with mock.patch.object(SERVICE, "package_locks", side_effect=ValueError("package manager became active")):
                launch()
                for _ in range(100):
                    if self.service.restart_status()["job"]["state"] == "failed":
                        break
                    time.sleep(0.01)
            self.assertEqual(self.service.restart_status()["job"]["state"], "failed")
            command.assert_not_called()

    def test_non_systemd_host_has_an_explicit_restart_unavailable_reason(self):
        with mock.patch.object(SERVICE.Path, "is_dir", return_value=False), mock.patch.object(SERVICE.subprocess, "run") as command:
            self.assertEqual(self.service.restart_status(), {"available": False, "reason": "Server restart requires a systemd host.", "job": None})
            command.assert_not_called()

    def test_restart_package_lock_probe_uses_only_fixed_paths_and_rejects_active_apt(self):
        with mock.patch.object(SERVICE.os, "open", return_value=51) as opened, mock.patch.object(SERVICE.os, "close") as closed, mock.patch.object(SERVICE.HOST.fcntl, "lockf", side_effect=BlockingIOError):
            with self.assertRaisesRegex(ValueError, "package manager is active"):
                with SERVICE.package_locks():
                    self.fail("locked package manager was ignored")
            opened.assert_called_once_with("/var/lib/dpkg/lock-frontend", SERVICE.os.O_RDWR | SERVICE.os.O_NOFOLLOW)
            closed.assert_called_once_with(51)

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

    def test_package_plan_is_rechecked_and_launched_as_a_fixed_systemd_unit(self):
        simulation = {
            "selected": [{"name": "base-files:arm64", "installedVersion": "1", "candidateVersion": "2", "sources": [{"trusted": True}]}],
            "operations": [{"name": "base-files", "installedVersion": "1", "candidateVersion": "2", "action": "upgrade"}],
        }
        with mock.patch.object(SERVICE.PACKAGES, "simulate_upgrades", return_value=simulation), mock.patch.object(
            SERVICE.subprocess, "run", return_value=mock.Mock(returncode=0)
        ) as launched:
            plan = self.service.package_plan(["base-files:arm64"])
            self.assertEqual(plan["expiresAt"], plan["createdAt"] + SERVICE.PLAN_TTL_SECONDS)
            accepted = self.service.package_apply(plan["planId"])
        self.assertEqual(accepted, {"jobId": plan["planId"], "state": "queued"})
        self.assertEqual(SERVICE.read_private(self.service.package_job_file)["state"], "queued")
        command = launched.call_args.args[0]
        self.assertEqual(command[:2], ["/usr/bin/systemd-run", f"--unit=orbis-package-{plan['planId']}"])
        self.assertEqual(command[-1], plan["planId"])
        with self.assertRaisesRegex(ValueError, "host package transaction"):
            self.service.plan(TARGET["tag"])
        finished = SERVICE.read_private(self.service.package_job_file)
        finished["state"] = "complete"
        SERVICE.write_private(self.service.package_job_file, finished)
        with self.assertRaisesRegex(ValueError, "already applied"):
            self.service.package_apply(plan["planId"])

    def test_package_apply_refuses_stale_apt_candidates(self):
        simulation = {"selected": [{"name": "base-files:arm64", "candidateVersion": "2"}], "operations": [{"name": "base-files", "candidateVersion": "2"}]}
        with mock.patch.object(SERVICE.PACKAGES, "simulate_upgrades", return_value=simulation) as simulate:
            plan = self.service.package_plan(["base-files:arm64"])
            simulate.return_value = {"selected": [{"name": "base-files:arm64", "candidateVersion": "3"}], "operations": []}
            with self.assertRaisesRegex(ValueError, "changed"):
                self.service.package_apply(plan["planId"])
        self.assertIsNone(SERVICE.read_private(self.service.package_job_file))

    def test_refresh_uses_a_distinct_plan_and_the_existing_isolated_worker(self):
        with mock.patch.object(SERVICE.PACKAGES, "require_ubuntu"), mock.patch.object(
            SERVICE.subprocess, "run", return_value=mock.Mock(returncode=0)
        ) as launch:
            result = self.service.package_refresh()
        record = SERVICE.read_private(self.state / f"package-plan-{result['jobId']}.json")
        self.assertEqual(record["schema"], "orbis.package-refresh.v1")
        self.assertEqual(set(record), {"schema", "id", "root", "createdAt"})
        self.assertEqual(self.service.package_job_status()["job"]["kind"], "refresh")
        self.assertEqual(launch.call_args.args[0][-1], result["jobId"])
        with self.assertRaisesRegex(ValueError, "host package transaction"):
            self.service.package_refresh()

    def test_only_stopped_index_refreshes_are_retryable_not_failed_installations(self):
        job = {"id": str(uuid.uuid4()), "state": "failed", "kind": "refresh"}
        with mock.patch.object(SERVICE.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="inactive\n")) as probe:
            self.assertTrue(self.service.refresh_retryable(job))
            self.assertFalse(self.service.refresh_retryable({**job, "kind": "install"}))
            self.assertFalse(self.service.refresh_retryable({**job, "state": "running"}))
            self.assertFalse(self.service.refresh_retryable({**job, "id": "not-an-id; shell"}))
            self.assertEqual(probe.call_count, 1)
        for state in ("active", "activating", "unknown"):
            with mock.patch.object(SERVICE.subprocess, "run", return_value=mock.Mock(returncode=0, stdout=state)):
                self.assertFalse(self.service.refresh_retryable(job))

    def test_failed_refresh_can_be_rechecked_but_does_not_enable_an_install(self):
        job = {"id": str(uuid.uuid4()), "state": "failed", "kind": "refresh"}
        with mock.patch.object(self.service, "require_healthy_core"), mock.patch.object(self.service, "package_job_status", return_value={"job": job}), \
             mock.patch.object(SERVICE.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="inactive\n")):
            self.assertEqual(self.service.require_package_ready(allow_refresh_retry=True), job)
            with self.assertRaisesRegex(ValueError, "previous host package transaction"):
                self.service.require_package_ready()

    def test_lost_worker_launch_response_cannot_overwrite_a_completed_transaction(self):
        simulation = {"selected": [{"name": "base-files:arm64", "candidateVersion": "2"}], "operations": [{"name": "base-files", "candidateVersion": "2"}]}
        def completed(command, **kwargs):
            job = SERVICE.read_private(self.service.package_job_file)
            job["state"] = "complete"
            SERVICE.write_private(self.service.package_job_file, job)
            raise subprocess.TimeoutExpired(command, 10)
        with mock.patch.object(SERVICE.PACKAGES, "simulate_upgrades", return_value=simulation), mock.patch.object(SERVICE.subprocess, "run", side_effect=completed):
            plan = self.service.package_plan(["base-files:arm64"])
            accepted = self.service.package_apply(plan["planId"])
        self.assertEqual(accepted["jobId"], plan["planId"])
        self.assertEqual(self.service.package_job_status()["job"]["state"], "complete")

    def test_inactive_unit_observation_cannot_clobber_a_worker_holding_the_transaction_lock(self):
        identifier = str(uuid.uuid4())
        job = {"schema": "orbis.package-job.v1", "id": identifier, "state": "running", "createdAt": time.time() - 10}
        SERVICE.write_private(self.service.package_job_file, job)
        with SERVICE.HOST.host_lock(self.root), mock.patch.object(SERVICE.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="inactive\n")):
            self.assertEqual(self.service.package_job_status()["job"]["state"], "running")
            job["state"] = "complete"
            SERVICE.write_private(self.service.package_job_file, job)
        self.assertEqual(self.service.package_job_status()["job"]["state"], "complete")

    def test_package_changes_require_a_healthy_enrolled_core(self):
        with mock.patch.object(
            self.service,
            "status",
            return_value={"enrolled": False, "imageMatches": False, "coreState": "running", "coreHealth": "healthy"},
        ):
            with self.assertRaisesRegex(ValueError, "healthy enrolled"):
                SERVICE.HostService.require_healthy_core(self.service)

    def test_inactive_package_worker_is_reported_as_interrupted(self):
        job_id = "00000000-0000-4000-8000-000000000000"
        SERVICE.write_private(
            self.service.package_job_file,
            {"schema": "orbis.package-job.v1", "id": job_id, "state": "running", "createdAt": time.time() - 10},
        )
        with mock.patch.object(SERVICE.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="inactive\n")):
            status = self.service.package_job_status()
        self.assertEqual(status["job"]["state"], "interrupted")
        with self.assertRaisesRegex(ValueError, "host package transaction"):
            self.service.plan(TARGET["tag"])

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

    def test_core_review_rejects_clock_rollback_and_nonfinite_creation_times(self):
        planned = self.service.plan(TARGET["tag"])
        file = self.state / f"plan-{planned['planId']}.json"
        record = SERVICE.read_private(file)
        created = record["createdAt"]
        for timestamp in (created + 60, float("nan"), float("inf")):
            with self.subTest(timestamp=timestamp):
                SERVICE.write_private(file, {**record, "createdAt": timestamp})
                with mock.patch.object(SERVICE.time, "time", return_value=created):
                    with self.assertRaisesRegex(ValueError, "expired"):
                        self.service._read_plan(planned["planId"])
                self.assertIsNone(SERVICE.read_private(self.service.job_file))

    def test_package_review_rejects_clock_rollback_before_dispatching_a_worker(self):
        simulation = {"selected": [{"name": "base-files"}], "operations": []}
        with mock.patch.object(SERVICE.PACKAGES, "simulate_upgrades", return_value=simulation), mock.patch.object(
            self.service, "start_package_worker"
        ) as worker:
            planned = self.service.package_plan(["base-files"])
            file = self.state / f"package-plan-{planned['planId']}.json"
            record = SERVICE.read_private(file)
            created = record["createdAt"]
            for timestamp in (created + 60, float("nan"), float("inf")):
                with self.subTest(timestamp=timestamp):
                    SERVICE.write_private(file, {**record, "createdAt": timestamp})
                    with mock.patch.object(SERVICE.time, "time", return_value=created):
                        with self.assertRaisesRegex(ValueError, "expired"):
                            self.service.package_apply(planned["planId"])
                    worker.assert_not_called()
                    self.assertIsNone(SERVICE.read_private(self.service.package_job_file))

    def test_snapshot_failure_keeps_safe_diagnostics_after_rollback(self):
        planned = self.service.plan(TARGET["tag"])
        failure = {"failureStage": "snapshotting", "failureCode": "snapshot-source-changed", "failureType": "SnapshotError"}

        def fail_after_rollback(root, current, target, context, snapshot):
            SERVICE.write_private(SERVICE.UPDATE.journal_path(snapshot), {"stage": "rolled-back", **failure})
            raise RuntimeError("SECRET_MARKER /private/password.env")

        with mock.patch.object(SERVICE.UPDATE, "apply_update", side_effect=fail_after_rollback):
            _, launch = self.service.apply(planned["planId"])
            launch()
            job = self.wait_for_job()
        self.assertEqual(job["state"], "rolled-back")
        self.assertEqual({key: job[key] for key in failure}, failure)
        self.assertEqual(job["message"], "Installation files changed while the backup was being copied. The previous Orbis release was restored.")
        self.assertNotIn("SECRET_MARKER", json.dumps(job))
        with mock.patch.object(SERVICE.HOST, "saved_state", return_value=None), mock.patch.object(SERVICE.HOST, "current_core", return_value={}):
            public = self.service.status()["job"]
        self.assertEqual({key: public[key] for key in failure}, failure)
        self.assertNotIn("snapshot", public)
        self.assertNotIn("SECRET_MARKER", json.dumps(public))

    def test_malformed_failure_metadata_is_not_returned_to_the_browser(self):
        cases = (
            {"failureStage": ["snapshotting"], "failureCode": "snapshot-copy-failed", "failureType": "SnapshotError"},
            {"failureStage": "snapshotting", "failureCode": "SECRET_MARKER", "failureType": "RuntimeError"},
            {"failureStage": "snapshotting", "failureCode": "snapshot-copy-failed", "failureType": ["RuntimeError"]},
            {"failureStage": "snapshotting", "failureCode": "snapshot-copy-failed", "failureType": "SECRET_MARKER"},
        )
        for failure in cases:
            with self.subTest(failure=failure):
                self.assertEqual(SERVICE.UPDATE.safe_failure(failure), {})
                self.assertEqual(SERVICE.UPDATE.failure_message(failure), "")

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
        with mock.patch.object(self.service.drives, "read", return_value={"available": False, "reason": "Collecting drive health readings."}) as drives, \
             mock.patch.object(self.service.drives, "start_test", return_value={"accepted": True}) as start_test:
            self.assertEqual(request("GET", "/v1/drives")[1]["reason"], "Collecting drive health readings.")
            self.assertEqual(request("GET", "/v1/drives?path=/etc/shadow")[0], 404)
            self.assertEqual(request("POST", "/v1/drives/test", {"id": "drive:" + "a" * 24, "kind": "short", "command": "shell"})[0], 409)
            self.assertEqual(request("POST", "/v1/drives/test", {"id": "drive:" + "a" * 24, "kind": "short"})[0], 202)
            drives.assert_called_once_with()
            start_test.assert_called_once_with("drive:" + "a" * 24, "short")
        with mock.patch.object(SERVICE.SENSORS, "read", return_value={"available": False, "reason": "Collecting sensor readings."}) as sensors:
            self.assertEqual(request("GET", "/v1/sensors")[1]["reason"], "Collecting sensor readings.")
            self.assertEqual(request("GET", "/v1/sensors?path=/etc/shadow")[0], 404)
            self.assertEqual(request("POST", "/v1/sensors", {"command": "probe"})[0], 404)
            sensors.assert_called_once_with()
        with mock.patch.object(SERVICE.PROCESSES, "read", return_value={"available": False, "reason": "Collecting process readings."}) as processes:
            self.assertEqual(request("GET", "/v1/processes")[1]["reason"], "Collecting process readings.")
            self.assertEqual(request("GET", "/v1/processes?pid=1")[0], 404)
            self.assertEqual(request("POST", "/v1/processes", {"signal": 9})[0], 404)
            processes.assert_called_once_with()
        with mock.patch.object(SERVICE.TELEMETRY, "read", return_value={"available": False, "reason": "Collecting host readings."}) as telemetry:
            self.assertEqual(request("GET", "/v1/telemetry")[1]["reason"], "Collecting host readings.")
            self.assertEqual(request("GET", "/v1/telemetry?path=/etc/shadow")[0], 404)
            self.assertEqual(request("POST", "/v1/telemetry", {"command": "probe"})[0], 404)
            telemetry.assert_called_once_with()
        self.assertEqual(request("POST", "/v1/plan", {"tag": TARGET["tag"], "command": "rm"})[0], 409)
        status, result = request("POST", "/v1/plan", {"tag": TARGET["tag"]})
        self.assertEqual(status, 200)
        self.assertEqual(result["targetTag"], TARGET["tag"])
        self.assertEqual(request("GET", "/v1/packages/job")[1]["job"], None)
        self.assertEqual(request("POST", "/v1/packages/plan", {"names": ["base-files:arm64"], "command": "shell"})[0], 409)
        with mock.patch.object(self.service, "package_plan", return_value={"planId": "fixture"}) as package_plan, mock.patch.object(
            self.service, "package_apply", return_value={"jobId": "fixture", "state": "queued"}
        ) as package_apply:
            self.assertEqual(request("POST", "/v1/packages/plan", {"names": ["base-files:arm64"]})[1]["planId"], "fixture")
            self.assertEqual(request("POST", "/v1/packages/apply", {"planId": "fixture"})[0], 202)
        package_plan.assert_called_once_with(["base-files:arm64"])
        package_apply.assert_called_once_with("fixture")
        launch = mock.Mock()
        with mock.patch.object(self.service, "restart_status", return_value={"available": True, "job": None}), mock.patch.object(
            self.service, "restart_plan", return_value={"planId": "fixture", "expiresAt": 123, "rebootRequired": False}
        ) as restart_plan, mock.patch.object(self.service, "restart_apply", return_value=({"jobId": "fixture", "state": "restarting"}, launch)) as restart_apply:
            self.assertTrue(request("GET", "/v1/restart")[1]["available"])
            self.assertEqual(request("POST", "/v1/restart/plan", {"command": "shell"})[0], 409)
            self.assertEqual(request("POST", "/v1/restart/apply", {"planId": "fixture", "args": ["--force"]})[0], 409)
            self.assertEqual(request("POST", "/v1/restart/plan", {})[1]["planId"], "fixture")
            self.assertEqual(request("POST", "/v1/restart/apply", {"planId": "fixture"})[0], 202)
        restart_plan.assert_called_once_with()
        restart_apply.assert_called_once_with("fixture")
        launch.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
