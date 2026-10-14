import importlib.util
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
    def test_manifest_requires_immutable_orbis_image(self):
        self.assertEqual(PLAN.validate_manifest(MANIFEST), MANIFEST)
        with self.assertRaises(ValueError):
            PLAN.validate_manifest({**MANIFEST, "digest": "latest"})
        with self.assertRaises(ValueError):
            PLAN.validate_manifest({**MANIFEST, "image": "ghcr.io/other/orbis"})

    def test_compose_error_does_not_expose_environment(self):
        failed = type("Result", (), {"returncode": 1, "stdout": "", "stderr": "SECRET=private-value"})()
        with patch.object(PLAN.subprocess, "run", return_value=failed):
            with self.assertRaisesRegex(RuntimeError, "could not validate") as failure:
                PLAN.compose_config(Path("/tmp"), [Path("/tmp/docker-compose.yml")])
        self.assertNotIn("private-value", str(failure.exception))

    @unittest.skipUnless(shutil.which("docker"), "Docker Compose is unavailable")
    def test_plan_keeps_core_services_and_user_override(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".env").write_text("TIPI_VERSION=4.10.1\nPOSTGRES_PASSWORD=private-value\n")
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
            self.assertEqual(result["candidateImage"], f"{MANIFEST['image']}@{MANIFEST['digest']}")
            self.assertNotIn("private-value", str(result))


if __name__ == "__main__":
    unittest.main()
