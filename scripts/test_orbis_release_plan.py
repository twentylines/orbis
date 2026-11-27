import importlib.util
import hashlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("orbis_release_plan", Path(__file__).with_name("orbis-release-plan.py"))
assert SPEC and SPEC.loader
PLAN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PLAN)

MANIFEST = {
    "schema": "orbis.release.v1",
    "image": "ghcr.io/twentylines/orbis",
    "tag": "v0.1.0",
    "commit": "a" * 40,
    "digest": "sha256:" + "b" * 64,
    "runtipiCompatibility": "4.10.1",
}


class OrbisReleasePlanTests(unittest.TestCase):
    def test_manifest_accepts_published_stable_nightly_identity_but_stable_helper_rejects_prereleases(self):
        beta = {**MANIFEST, "tag": "v0.1.0-beta.96"}
        rc = {**MANIFEST, "tag": "v0.1.0-rc.1"}
        self.assertIs(PLAN.validate_manifest(beta), beta)
        self.assertIs(PLAN.validate_manifest(rc), rc)
        self.assertNotIn("releaseChannel", beta)
        self.assertTrue(PLAN.is_stable_release_tag(MANIFEST["tag"]))
        self.assertFalse(PLAN.is_stable_release_tag(beta["tag"]))
        self.assertFalse(PLAN.is_stable_release_tag(rc["tag"]))
        for tag in ["v0.1.0-nightly.20261025", "v0.1.0-dev.1", "v0.1.0-alpha.1", "v01.0.0", "v0.1.0-beta.01"]:
            with self.subTest(tag=tag), self.assertRaisesRegex(ValueError, "published Stable or Nightly release"):
                PLAN.validate_manifest({**MANIFEST, "tag": tag})

    def test_manifest_requires_immutable_orbis_image(self):
        self.assertEqual(PLAN.validate_manifest(MANIFEST), MANIFEST)
        with self.assertRaises(ValueError):
            PLAN.validate_manifest({**MANIFEST, "digest": "latest"})
        with self.assertRaises(ValueError):
            PLAN.validate_manifest({**MANIFEST, "image": "ghcr.io/other/orbis"})

    def test_412_manifest_requires_explicit_protocol_and_exact_base(self):
        candidate = {**MANIFEST, "tag": "v0.9.2-rc.1", "runtipiCompatibility": "4.12.0"}
        with self.assertRaisesRegex(ValueError, "canonical base and installation protocol"):
            PLAN.validate_manifest(candidate)
        candidate["installationProtocol"] = PLAN.INSTALLATION_PROTOCOL
        self.assertIs(PLAN.validate_manifest(candidate), candidate)
        for unsupported in ["4.11.0", "4.12.1", "v4.12.0", "4.12.0-rc.1"]:
            with self.subTest(base=unsupported), self.assertRaises(ValueError):
                PLAN.validate_manifest({**candidate, "runtipiCompatibility": unsupported})
        self.assertEqual(PLAN.image_compatibility({}), "4.10.1")
        self.assertEqual(PLAN.image_compatibility({PLAN.RUNTIPI_BASE_LABEL: "4.12.0"}), "4.12.0")
        with self.assertRaises(ValueError):
            PLAN.image_compatibility({PLAN.RUNTIPI_BASE_LABEL: "4.12.1"})

    def test_412_same_base_plan_requires_matching_compose_and_installation_version(self):
        target = {**MANIFEST, "runtipiCompatibility": "4.12.0", "installationProtocol": PLAN.INSTALLATION_PROTOCOL}
        services = {name: {} for name in ("runtipi", "runtipi-db", "runtipi-queue", "runtipi-reverse-proxy")}
        compose = {"services": services}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with patch.object(PLAN, "compose_config", return_value=compose) as config, patch.object(PLAN.PREFLIGHT, "inspect", return_value={
                "layout": "orbis-v1", "result": "inventory-only",
            }):
                (root / "VERSION").write_text("4.10.1\n")
                with self.assertRaisesRegex(ValueError, "installed Runtipi version"):
                    PLAN.plan(root, target)
                config.assert_called_once()
                (root / "VERSION").write_text("4.12.0\n")
                services["runtipi"]["environment"] = {"TIPI_VERSION": "4.10.1"}
                with self.assertRaisesRegex(ValueError, "current controller Runtipi version"):
                    PLAN.plan(root, target)
                services["runtipi"]["environment"]["TIPI_VERSION"] = "4.12.0"
                self.assertEqual(PLAN.plan(root, target)["installedRuntipiVersion"], "4.12.0")
                with self.assertRaisesRegex(ValueError, "installed Runtipi version"):
                    PLAN.plan(root, MANIFEST)

    @unittest.skipUnless(shutil.which("docker"), "Docker Compose is unavailable")
    def test_cross_base_review_preserves_exact_files_and_refuses_other_compose_changes(self):
        current = {**MANIFEST, "tag": "v0.9.1", "installationProtocol": PLAN.INSTALLATION_PROTOCOL}
        target = {**current, "tag": "v0.9.2-rc.1", "commit": "c" * 40, "digest": "sha256:" + "d" * 64,
                  "runtipiCompatibility": "4.12.0"}
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"COMPOSE_PROFILES": ""}):
            root = Path(folder).resolve()
            for name in PLAN.PREFLIGHT.DATA_PATHS:
                (root / name).mkdir()
            (root / "data/postgres").mkdir(parents=True)
            (root / "VERSION").write_bytes(b"v4.10.1\n")
            env = ("TIPI_VERSION='v4.10.1' # retained comment\nROOT_FOLDER_HOST=" + str(root) + "\n").encode()
            env_file = root / ".env"
            env_file.write_bytes(env)
            config = {
                "services": {
                    "runtipi": {
                        "image": current["image"] + "@" + current["digest"],
                        "env_file": [".env"],
                        "environment": {"ORBIS_VERSION": current["tag"], "ORBIS_COMMIT": current["commit"], "ORBIS_IMAGE_DIGEST": current["digest"]},
                        "volumes": ["./.env:/data/.env", "./app-data:/app-data"],
                    },
                    "runtipi-db": {"image": "postgres:14", "volumes": ["./data/postgres:/var/lib/postgresql/data"]},
                    "runtipi-queue": {"image": "rabbitmq:4-alpine"},
                    "runtipi-reverse-proxy": {"image": "traefik:v3.6"},
                },
            }
            compose = root / "docker-compose.yml"
            compose.write_text(json.dumps(config))
            original_paths = {file: file.read_bytes() for file in (compose, env_file, root / "VERSION")}
            result = PLAN.review_412(root, current, target)
            self.assertEqual(result["result"], "runtipi-compatibility-reviewed")
            self.assertEqual(result["targetRuntipiVersion"], "4.12.0")
            self.assertFalse(result["runtimeInspected"])
            expected_env = env.replace(b"v4.10.1", b"4.12.0")
            self.assertEqual(result["prospectiveFileSha256"][".env"], hashlib.sha256(expected_env).hexdigest())
            self.assertEqual(result["prospectiveFileSha256"]["VERSION"], hashlib.sha256(b"4.12.0\n").hexdigest())
            self.assertEqual({file: file.read_bytes() for file in original_paths}, original_paths)
            self.assertNotIn(str(root), str(result))
            override = PLAN.override_yaml(target) + "      TIPI_VERSION: 4.12.0\n"
            self.assertEqual(result["prospectiveOverrideSha256"], hashlib.sha256(override.encode()).hexdigest())
            env_file.write_bytes(expected_env)
            (root / "VERSION").write_bytes(b"4.12.0\n")
            actual_target = PLAN.compose_config(root, [compose], override, all_profiles=True)
            self.assertEqual(result["prospectiveComposeSha256"], hashlib.sha256(json.dumps(actual_target, sort_keys=True).encode()).hexdigest())
            env_file.write_bytes(env)
            (root / "VERSION").write_bytes(original_paths[root / "VERSION"])
            with self.assertRaisesRegex(ValueError, "Review only a forward"):
                PLAN.review_412(root, target, current)
            for wrong in (b"TIPI_VERSION=4.12.0\n", b"TIPI_VERSION=4.10.1\nTIPI_VERSION=4.10.1\n"):
                env_file.write_bytes(wrong)
                with self.assertRaisesRegex(ValueError, "declare the current TIPI_VERSION"):
                    PLAN.review_412(root, current, target)
            env_file.write_bytes(b"EXAMPLE_VALUE='first line\nTIPI_VERSION=4.10.1\nlast line'\n")
            with self.assertRaisesRegex(ValueError, "does not resolve to the reviewed TIPI_VERSION"):
                PLAN.review_412(root, current, target)
            env_file.write_bytes(env)
            config["services"]["profiled"] = {"profiles": ["additional"], "image": "busybox", "command": "echo ${TIPI_VERSION}"}
            compose.write_text(json.dumps(config))
            with self.assertRaisesRegex(ValueError, "would change retained Compose configuration"):
                PLAN.review_412(root, current, target)
            config["services"]["profiled"] = {"profiles": ["additional"], "image": "busybox", "env_file": [".env"]}
            compose.write_text(json.dumps(config))
            with self.assertRaisesRegex(ValueError, "Another service uses the root environment file"):
                PLAN.review_412(root, current, target)

    def test_manifest_validates_optional_channel_and_update_priority(self):
        self.assertEqual(PLAN.validate_manifest({**MANIFEST, "releaseChannel": "stable", "updatePriority": "critical"})["releaseChannel"], "stable")
        beta = {**MANIFEST, "tag": "v0.1.0-beta.1", "releaseChannel": "nightly", "updatePriority": "normal"}
        self.assertIs(PLAN.validate_manifest(beta), beta)
        for invalid in (
            {**MANIFEST, "releaseChannel": "nightly"},
            {**MANIFEST, "tag": "v0.1.0-beta.1", "releaseChannel": "stable"},
            {**MANIFEST, "releaseChannel": "preview"},
            {**MANIFEST, "updatePriority": "urgent"},
            {**MANIFEST, "updatePriority": None},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                PLAN.validate_manifest(invalid)

    def test_manifest_validates_source_bound_critical_through_marker(self):
        stable = {**MANIFEST, "criticalThrough": "v0.1.0"}
        beta = {**MANIFEST, "tag": "v0.1.0-beta.10", "criticalThrough": "v0.1.0-beta.9"}
        self.assertIs(PLAN.validate_manifest(stable), stable)
        self.assertIs(PLAN.validate_manifest(beta), beta)
        for invalid in (
            {**MANIFEST, "criticalThrough": "v0.1.0-beta.1"},
            {**MANIFEST, "tag": "v0.1.0-beta.10", "criticalThrough": "v0.1.0"},
            {**MANIFEST, "criticalThrough": "v0.2.0"},
            {**MANIFEST, "criticalThrough": "development"},
        ):
            with self.assertRaises(ValueError):
                PLAN.validate_manifest(invalid)

    def test_manifest_validates_bounded_cross_channel_critical_fix_frontier(self):
        valid = {**MANIFEST, "criticalFixes": ["v0.1.0-beta.2", "v0.1.0"]}
        self.assertIs(PLAN.validate_manifest(valid), valid)
        for invalid in (
            {**MANIFEST, "criticalFixes": "v0.1.0"},
            {**MANIFEST, "criticalFixes": ["v0.1.0-dev.1"]},
            {**MANIFEST, "criticalFixes": ["v0.1.0", "v0.1.0"]},
            {**MANIFEST, "criticalFixes": ["v0.1.0"] * 129},
        ):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, "critical-fix frontier"):
                PLAN.validate_manifest(invalid)

    def test_compose_error_does_not_expose_environment(self):
        failed = type("Result", (), {"returncode": 1, "stdout": "", "stderr": "SECRET=private-value"})()
        with patch.object(PLAN.subprocess, "run", return_value=failed):
            with self.assertRaisesRegex(RuntimeError, "could not validate") as failure:
                PLAN.compose_config(Path("/tmp"), [Path("/tmp/docker-compose.yml")])
        self.assertNotIn("private-value", str(failure.exception))

    def test_installation_requires_an_explicit_supported_protocol_without_breaking_legacy_updates(self):
        self.assertEqual(PLAN.validate_manifest(MANIFEST), MANIFEST)
        with self.assertRaisesRegex(ValueError, "does not declare"):
            PLAN.require_installation_protocol(MANIFEST)
        supported = {**MANIFEST, "installationProtocol": PLAN.INSTALLATION_PROTOCOL}
        self.assertEqual(PLAN.require_installation_protocol(supported), supported)
        for protocol in [None, 1, "normal", "orbis.installation-state.v2"]:
            with self.subTest(protocol=protocol), self.assertRaisesRegex(ValueError, "unsupported installation protocol"):
                PLAN.validate_manifest({**MANIFEST, "installationProtocol": protocol})

    @unittest.skipUnless(shutil.which("docker"), "Docker Compose is unavailable")
    def test_plan_keeps_core_services_and_user_override(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".env").write_text(f"TIPI_VERSION=4.10.1\nROOT_FOLDER_HOST={root}\nPOSTGRES_PASSWORD=private-value\n")
            (root / "docker-compose.yml").write_text(
                "services:\n"
                "  runtipi:\n"
                "    image: ghcr.io/runtipi/runtipi:v4.10.1\n"
                "    environment:\n"
                "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}\n"
                "  runtipi-db:\n"
                "    image: postgres:14\n"
                "    volumes:\n"
                "      - ./data/postgres:/var/lib/postgresql/data\n"
                "  runtipi-queue:\n"
                "    image: rabbitmq:4-alpine\n"
                "  runtipi-reverse-proxy:\n"
                "    image: traefik:v3.6\n"
            )
            for name in PLAN.PREFLIGHT.DATA_PATHS:
                (root / name).mkdir()
            (root / "data" / "postgres").mkdir(parents=True)
            override = root / "user-config" / "tipi-compose.yml"
            override.write_text("services:\n  runtipi:\n    labels:\n      example: preserved\n")

            result = PLAN.plan(root, MANIFEST)
            self.assertEqual(result["result"], "plan-ready")
            self.assertTrue(result["userOverrideIncluded"])
            self.assertEqual(result["configuredImage"], "ghcr.io/runtipi/runtipi:v4.10.1")
            self.assertFalse(result["runtimeInspected"])
            self.assertEqual(result["candidateImage"], f"{MANIFEST['image']}@{MANIFEST['digest']}")
            self.assertNotIn("private-value", str(result))


if __name__ == "__main__":
    unittest.main()
