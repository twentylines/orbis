import copy
import hashlib
import io
import json
import subprocess
import sys
import unittest
from unittest import mock

from test_orbis_controller_identity import fixture as publication_fixture
import test_orbis_host_controller_config as CONFIG_FIXTURE


SERVICE = CONFIG_FIXTURE.SERVICE
IDENTITY = SERVICE.CONTROLLER_IDENTITY


class ControllerPublicationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = CONFIG_FIXTURE.ControllerConfigTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.service = self.fixture.service
        self.release, blobs = publication_fixture()
        self.verified = IDENTITY.verify_published_graph(self.release, **blobs)
        self.proof = self.verified.proof()
        self.fixture.image = self.verified.config_digest
        self.fixture.identity.update(imageId=self.fixture.image, imageReference=self.release["image"] + "@" + self.release["digest"])
        saved = SERVICE.HOST.saved_state(self.fixture.root)
        saved.update(tag=self.release["tag"], digest=self.release["digest"])
        SERVICE.HOST.write_state(self.fixture.root, saved)
        self.local = {"Id": self.fixture.image, "Os": "linux", "Architecture": "arm64", "Variant": "",
                      "RepoDigests": [self.fixture.identity["imageReference"]],
                      "RootFS": {"Type": "layers", "Layers": list(self.verified.rootfs_diff_ids)},
                      "Config": {"Labels": json.loads(blobs["config_bytes"])["config"]["Labels"]}}
        self.fixture.docker.side_effect = self.inspect
        baseline = self.fixture.capture()
        self.request = {"pointId": self.fixture.point, "controllerId": self.fixture.controller, "imageId": self.fixture.image,
                        "configurationSetSha256": baseline["configurationSetSha256"]}
        self.worker = self.enterContext(mock.patch.object(IDENTITY, "produce_bounded_publication", return_value=self.proof))

    def inspect(self, _context, arguments, _root):
        value = self.local if arguments[0] == "image" else self.fixture.identity
        return mock.Mock(returncode=0, stdout=json.dumps(value))

    def prepare(self):
        return self.service.prepare_controller_publication(self.request)

    def test_receipt_binds_exact_point_root_config_controller_and_publication(self):
        receipt = self.prepare()
        self.assertEqual(receipt["pointId"], self.fixture.point)
        self.assertEqual(receipt["controller"]["imageId"], self.verified.config_digest)
        self.assertEqual(receipt["controller"]["releaseDigest"], self.release["digest"])
        self.assertEqual(receipt["configurationSetSha256"], self.request["configurationSetSha256"])
        self.assertEqual(receipt["proof"], self.proof)
        self.assertNotIn("files", receipt)
        self.assertNotIn(str(self.fixture.root), json.dumps(receipt))
        seal = receipt.pop("preparationSha256")
        self.assertEqual(seal, hashlib.sha256(b"orbis.controller-publication-capture.v1\n" + IDENTITY.canonical(receipt)).hexdigest())
        self.worker.assert_called_once()
        self.assertEqual(self.worker.call_args.args[:2], (self.release["tag"], {"os": "linux", "architecture": "arm64"}))
        self.assertLessEqual(self.worker.call_args.kwargs["timeout_seconds"], 120)

    def test_docker29_source_index_is_distinct_from_config_and_platform(self):
        source = "sha256:" + "9" * 64
        self.fixture.image = source
        self.fixture.identity["imageId"] = source
        self.local["Id"] = source
        self.local["Manifests"] = [{"Kind": "image", "Available": True, "Descriptor": {
            "digest": self.verified.manifest_digest, "platform": {"os": "linux", "architecture": "arm64"}}}]
        self.request["imageId"] = source
        self.request["configurationSetSha256"] = self.fixture.capture()["configurationSetSha256"]
        receipt = self.prepare()
        self.assertEqual(receipt["controller"]["imageId"], source)
        self.assertNotEqual(source, self.verified.config_digest)
        self.assertNotEqual(source, self.verified.manifest_digest)

    def test_docker29_imagedata_platform_fallback_is_explicit_and_conflicts_fail(self):
        source = "sha256:" + "9" * 64
        self.fixture.image = source
        self.fixture.identity["imageId"] = source
        self.local["Id"] = source
        self.local["Manifests"] = [{"Kind": "image", "Available": True,
            "Descriptor": {"digest": self.verified.manifest_digest},
            "ImageData": {"Platform": {"os": "linux", "architecture": "arm64"}}}]
        self.request["imageId"] = source
        self.request["configurationSetSha256"] = self.fixture.capture()["configurationSetSha256"]
        self.assertEqual(self.prepare()["controller"]["imageId"], source)
        entry = self.local["Manifests"][0]
        entry["Descriptor"]["platform"] = {"os": "linux", "architecture": "amd64"}
        with self.assertRaises(ValueError):
            self.prepare()
        entry["Descriptor"].pop("platform")
        entry.pop("ImageData")
        with self.assertRaises(ValueError):
            self.prepare()

    def cli_index(self):
        source = self.release["digest"]
        self.fixture.image = source
        self.fixture.identity["imageId"] = source
        self.local["Id"] = source
        self.local.pop("Manifests", None)
        selected = copy.deepcopy(self.local)
        selected["Id"] = self.verified.manifest_digest
        def inspect(_context, arguments, _root):
            value = selected if "--platform" in arguments else self.local
            return mock.Mock(returncode=0, stdout=json.dumps(value if arguments[0] == "image" else self.fixture.identity))
        self.fixture.docker.side_effect = inspect
        self.request["imageId"] = source
        self.request["configurationSetSha256"] = self.fixture.capture()["configurationSetSha256"]
        self.fixture.docker.reset_mock()
        return selected

    def test_docker29_cli_without_manifests_uses_explicit_platform_and_preserves_source(self):
        self.cli_index()
        receipt = self.prepare()
        self.assertEqual(receipt["controller"]["imageId"], self.release["digest"])
        selected_calls = [call.args[1] for call in self.fixture.docker.call_args_list if "--platform" in call.args[1]]
        self.assertEqual(selected_calls, [["image", "inspect", "--platform", "linux/arm64", "--format", "{{json .}}", self.release["digest"]]] * 2)
        self.assertLessEqual(self.worker.call_args.kwargs["timeout_seconds"], 90)
        self.assertIsNone(SERVICE.HOST.CAPTURE_READ_DEADLINE.get())

    def test_explicit_platform_must_match_publication_rootfs_labels_and_architecture(self):
        selected = self.cli_index()
        original = copy.deepcopy(selected)
        mutations = (lambda value: value.update(Id="sha256:" + "0" * 64),
                     lambda value: value["RootFS"].update(Layers=[]),
                     lambda value: value["Config"]["Labels"].update({"org.opencontainers.image.revision": "b" * 40}),
                     lambda value: value.update(Architecture="amd64"))
        for mutation in mutations:
            selected.clear()
            selected.update(copy.deepcopy(original))
            mutation(selected)
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                self.prepare()
            self.assertIsNone(SERVICE.HOST.CAPTURE_READ_DEADLINE.get())

    def test_selected_platform_drift_during_final_reads_fails_and_releases_locks(self):
        selected = self.cli_index()
        calls = 0
        original = self.fixture.docker.side_effect
        def inspect(context, arguments, root):
            nonlocal calls
            if "--platform" in arguments:
                calls += 1
                if calls == 2:
                    selected["RootFS"]["Layers"] = []
            return original(context, arguments, root)
        self.fixture.docker.side_effect = inspect
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertEqual(calls, 2)
        self.assertTrue(self.service.lock.acquire(blocking=False))
        self.service.lock.release()
        self.assertIsNone(SERVICE.HOST.CAPTURE_READ_DEADLINE.get())

    def test_image_and_configuration_reads_preserve_shorter_or_expired_outer_deadlines(self):
        self.cli_index()
        original = self.fixture.docker.side_effect
        for deadline in (SERVICE.time.monotonic() + 1, 0.0):
            def inspect(context, arguments, root):
                self.assertLessEqual(SERVICE.HOST.CAPTURE_READ_DEADLINE.get(), deadline)
                return original(context, arguments, root)
            self.fixture.docker.side_effect = inspect
            token = SERVICE.HOST.CAPTURE_READ_DEADLINE.set(deadline)
            try:
                self.service.publication_image(self.fixture.image, {"os": "linux", "architecture": "arm64"})
                if deadline == 0.0:
                    with self.assertRaises(ValueError):
                        self.service._capture_controller_config_locked(self.fixture.point, self.fixture.controller, self.fixture.image)
                else:
                    self.service._capture_controller_config_locked(self.fixture.point, self.fixture.controller, self.fixture.image)
                self.assertEqual(SERVICE.HOST.CAPTURE_READ_DEADLINE.get(), deadline)
            finally:
                SERVICE.HOST.CAPTURE_READ_DEADLINE.reset(token)

    def test_wrong_identity_config_or_caller_selected_authority_is_rejected(self):
        for key, value in (("tag", self.release["tag"]), ("root", "/not-allowed"), ("platform", {"os": "linux"}),
                           ("url", "https://example.test"), ("proof", self.proof)):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.service.prepare_controller_publication({**self.request, key: value})
        for key, value in (("pointId", "bad"), ("controllerId", "b" * 64), ("imageId", "sha256:" + "8" * 64),
                           ("configurationSetSha256", "8" * 64)):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.service.prepare_controller_publication({**self.request, key: value})
        self.worker.assert_not_called()

    def test_strict_published_v1_alias_is_not_relaxed(self):
        self.local["RepoDigests"] = []
        with self.assertRaises(ValueError):
            self.prepare()
        self.worker.assert_not_called()

    def test_config_file_or_controller_restart_during_fetch_is_rejected(self):
        for kind in ("config", "restart"):
            def worker(*_args, **_kwargs):
                if kind == "config":
                    (self.fixture.root / ".env").write_bytes(b"changed generation")
                else:
                    self.fixture.identity["startedAt"] = "new generation"
                return self.proof
            with self.subTest(kind=kind), mock.patch.object(IDENTITY, "produce_bounded_publication", side_effect=worker), \
                    self.assertRaises(ValueError):
                self.prepare()
            if kind == "config":
                (self.fixture.root / ".env").write_bytes(self.fixture.values[".env"])
                self.request["configurationSetSha256"] = self.fixture.capture()["configurationSetSha256"]

    def test_local_image_drift_rootfs_and_published_graph_mismatch_are_rejected(self):
        original = copy.deepcopy(self.local)
        for mutation in (lambda l: l["RootFS"].update(Layers=[]),
                         lambda l: l["Config"]["Labels"].update({"org.opencontainers.image.revision": "b" * 40}),
                         lambda l: l.update(Architecture="amd64"),
                         lambda l: l.update(Manifests=[{"Kind": "image", "Available": True,
                                                        "Descriptor": {"digest": "sha256:" + "0" * 64,
                                                                       "platform": {"os": "linux", "architecture": "arm64"}}}])):
            self.local = copy.deepcopy(original)
            mutation(self.local)
            with self.assertRaises(ValueError):
                self.prepare()

    def test_oversized_whole_receipt_rejected_and_locks_released_after_worker_failure(self):
        with mock.patch.object(IDENTITY, "PROOF_WIRE_BYTES", 100), self.assertRaises(ValueError):
            self.prepare()
        with mock.patch.object(IDENTITY, "produce_bounded_publication", side_effect=ValueError("private diagnostic")), \
                self.assertRaises(ValueError):
            self.prepare()
        self.assertTrue(self.service.lock.acquire(blocking=False))
        self.service.lock.release()
        with SERVICE.HOST.host_lock(self.fixture.root):
            pass

    def test_capability_is_read_only_and_http_errors_do_not_disclose_diagnostics(self):
        handler = object.__new__(SERVICE.Handler)
        handler.path = "/v1/controller-publication/capability"
        handler.server = mock.Mock(service=self.service)
        handler.send_json = mock.Mock()
        with mock.patch.object(self.service, "status", side_effect=AssertionError("No status")):
            handler.do_GET()
        self.assertEqual(handler.send_json.call_args.args, (200, {"version": 1, "capability": "controller-publication.v1"}))
        handler.path = "/v1/controller-publication/prepare"
        handler.body = mock.Mock(return_value={**self.request, "tag": self.release["tag"]})
        handler.do_POST()
        self.assertEqual(handler.send_json.call_args.args[0], 409)
        handler.body.assert_called_once_with(1024)
        handler.body.return_value = self.request
        with mock.patch.object(self.service, "prepare_controller_publication", side_effect=ValueError("private diagnostic")):
            handler.do_POST()
        self.assertNotIn("private diagnostic", json.dumps(handler.send_json.call_args.args))


class BoundedPublicationWorkerTests(unittest.TestCase):
    def test_internal_worker_only_emits_a_bounded_verified_proof(self):
        release, blobs = publication_fixture()
        verified = IDENTITY.verify_published_graph(release, **blobs)
        output = io.BytesIO()
        with mock.patch.object(IDENTITY, "produce_publication_proof", return_value=verified) as produce:
            IDENTITY.publication_worker(io.BytesIO(IDENTITY.canonical({"tag": release["tag"], "platform": {"os": "linux", "architecture": "arm64"}})), output)
        self.assertEqual(json.loads(output.getvalue()), verified.proof())
        produce.assert_called_once()
        with mock.patch.object(IDENTITY, "produce_publication_proof", return_value=verified), \
                mock.patch.object(IDENTITY, "PROOF_WIRE_BYTES", 10), self.assertRaises(ValueError):
            IDENTITY.publication_worker(io.BytesIO(IDENTITY.canonical({"tag": release["tag"], "platform": {"os": "linux", "architecture": "arm64"}})), io.BytesIO())

    def test_worker_rejects_extra_fields_and_cancelled_request_before_launch(self):
        with self.assertRaises(ValueError):
            IDENTITY.publication_worker(io.BytesIO(b'{"tag":"v0.5.0-beta.3","platform":{},"path":"bad"}'), io.BytesIO())
        with mock.patch.object(IDENTITY.subprocess, "Popen") as launch, self.assertRaises(ValueError):
            IDENTITY.produce_bounded_publication("v0.5.0-beta.3", {"os": "linux", "architecture": "arm64"}, lambda: True)
        launch.assert_not_called()

    def child(self, source):
        original = subprocess.Popen
        children = []
        def launch(_fixed_command, **options):
            process = original([sys.executable, "-c", source], **options)
            children.append(process)
            return process
        return children, mock.patch.object(IDENTITY.subprocess, "Popen", side_effect=launch)

    def test_absolute_timeout_kills_and_reaps_worker(self):
        children, launch = self.child("import time; time.sleep(3)")
        with launch, self.assertRaises(ValueError):
            IDENTITY.produce_bounded_publication("v0.5.0-beta.3", {"os": "linux", "architecture": "arm64"}, timeout_seconds=0.05)
        self.assertIsNotNone(children[0].poll())

    def test_worker_output_budget_kills_and_reaps_worker(self):
        children, launch = self.child("import sys,time; sys.stdout.write('x'*1024);sys.stdout.flush();time.sleep(3)")
        with launch, mock.patch.object(IDENTITY, "PROOF_WIRE_BYTES", 100), self.assertRaises(ValueError):
            IDENTITY.produce_bounded_publication("v0.5.0-beta.3", {"os": "linux", "architecture": "arm64"})
        self.assertIsNotNone(children[0].poll())

    def test_cancellation_kills_and_reaps_worker(self):
        children, launch = self.child("import time;time.sleep(3)")
        calls = 0
        def cancelled():
            nonlocal calls
            calls += 1
            return calls > 2
        with launch, self.assertRaises(ValueError):
            IDENTITY.produce_bounded_publication("v0.5.0-beta.3", {"os": "linux", "architecture": "arm64"}, cancelled)
        self.assertIsNotNone(children[0].poll())


if __name__ == "__main__":
    unittest.main()
