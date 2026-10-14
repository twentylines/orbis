import importlib.util
import tempfile
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location("orbis_stage_release", Path(__file__).with_name("orbis-stage-release.py"))
assert SPEC and SPEC.loader
STAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STAGE)

MANIFEST = {
    "schema": "orbis.release.v1",
    "image": "ghcr.io/twentylines/orbis",
    "tag": "v0.1.0-beta.2",
    "commit": "a" * 40,
    "digest": "sha256:" + "b" * 64,
    "runtipiCompatibility": "4.10.1",
}


class OrbisStageReleaseTests(unittest.TestCase):
    def test_stages_only_core_image_and_build_identity(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            target = root / "orbis-compose.yml"
            result = STAGE.stage(root, MANIFEST)
            self.assertEqual(result["result"], "staged")
            self.assertEqual(target.read_text(), STAGE.staged_content(MANIFEST))
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)
            self.assertEqual(STAGE.stage(root, MANIFEST)["result"], "already-staged")

    def test_replaces_only_an_earlier_generated_override(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            previous = {**MANIFEST, "tag": "v0.1.0-beta.1", "digest": "sha256:" + "c" * 64}
            STAGE.stage(root, previous)
            STAGE.stage(root, MANIFEST)
            self.assertEqual((root / "orbis-compose.yml").read_text(), STAGE.staged_content(MANIFEST))

    def test_preserves_manual_override_and_symlink(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            target = root / "orbis-compose.yml"
            target.write_text("services:\n  runtipi:\n    privileged: true\n")
            with self.assertRaisesRegex(ValueError, "custom content"):
                STAGE.stage(root, MANIFEST)
            self.assertIn("privileged: true", target.read_text())
            target.unlink()
            target.symlink_to(root / "missing")
            with self.assertRaisesRegex(ValueError, "symlink"):
                STAGE.stage(root, MANIFEST)


if __name__ == "__main__":
    unittest.main()
