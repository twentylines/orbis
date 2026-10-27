import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("orbis-release-metadata.py")
SPEC = importlib.util.spec_from_file_location("orbis_release_metadata", SCRIPT)
assert SPEC and SPEC.loader
METADATA = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(METADATA)


class ReleaseMetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.releases = Path(self.temp.name) / "releases"
        self.releases.mkdir()

    def notes_file(self, tag: str, notes: bytes | str) -> Path:
        path = self.releases / f"{tag}.md"
        path.write_bytes(notes.encode("utf-8") if isinstance(notes, str) else notes)
        return path

    def test_strict_published_tags_and_beta_rc_display_versions(self):
        beta = METADATA.release_metadata("v1.0.1-beta.3", self.notes_file("v1.0.1-beta.3", "notes"))
        self.assertEqual(beta, {
            "tag": "v1.0.1-beta.3", "displayVersion": "1.0.1 beta 3", "channel": "nightly",
            "prerelease": True, "priority": "normal", "kind": "maintenance",
        })
        rc = METADATA.release_metadata("v2.4.0-rc.2", self.notes_file("v2.4.0-rc.2", "notes"))
        self.assertEqual(rc["displayVersion"], "2.4.0 rc 2")
        self.assertEqual(rc["channel"], "nightly")
        stable = METADATA.release_metadata("v2.4.0", self.notes_file("v2.4.0", "notes"))
        self.assertEqual((stable["displayVersion"], stable["channel"], stable["prerelease"]), ("2.4.0", "stable", False))
        for invalid in ("1.0.0", "v01.0.0", "v1.0.0-beta.00", "v1.0.0-nightly.20261027", "v9007199254740992.0.0"):
            with self.subTest(tag=invalid), self.assertRaisesRegex(ValueError, "strict published"):
                METADATA.release_metadata(invalid, self.notes_file(invalid, "notes"))

    def test_leading_headers_are_order_independent_and_only_headers_are_removed(self):
        for headers in (
            "<!-- orbis-release-kind: feature -->\n<!-- orbis-update-priority: critical -->\n",
            "<!-- orbis-update-priority: critical -->\n<!-- orbis-release-kind: feature -->\n",
        ):
            body, kind, priority = METADATA.parse_release_notes(headers + "Critical issue in body\n")
            self.assertEqual((body, kind, priority), ("Critical issue in body\n", "feature", "critical"))
        metadata = METADATA.release_metadata(
            "v1.0.0", self.notes_file("v1.0.0", "- critical incident\n<!-- orbis-update-priority: critical -->\n")
        )
        self.assertEqual(metadata["priority"], "normal")
        self.assertEqual(metadata["kind"], "maintenance")

    def test_invalid_or_repeated_headers_are_not_stripped_or_inferred(self):
        invalid = "<!-- orbis-release-kind: critical -->\nBody\n"
        body, kind, priority = METADATA.parse_release_notes(invalid)
        self.assertEqual((body, kind, priority), (invalid, "maintenance", "normal"))
        repeated = "<!-- orbis-release-kind: feature -->\n<!-- orbis-release-kind: maintenance -->\nBody"
        body, kind, priority = METADATA.parse_release_notes(repeated)
        self.assertEqual((body, kind, priority), ("<!-- orbis-release-kind: maintenance -->\nBody", "feature", "normal"))

    def test_notes_size_utf8_empty_and_filename_validation(self):
        empty = self.notes_file("v1.0.0", b"")
        with self.assertRaisesRegex(ValueError, "changelog"):
            METADATA.release_metadata("v1.0.0", empty)
        only_headers = self.notes_file("v1.0.0", "<!-- orbis-update-priority: critical -->\n ")
        with self.assertRaisesRegex(ValueError, "changelog"):
            METADATA.release_metadata("v1.0.0", only_headers)
        oversized = self.notes_file("v1.0.1", b"x" * (64 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, "64 KiB"):
            METADATA.release_metadata("v1.0.1", oversized)
        invalid_utf8 = self.notes_file("v1.0.2", b"\xff")
        with self.assertRaisesRegex(ValueError, "UTF-8"):
            METADATA.release_metadata("v1.0.2", invalid_utf8)
        with self.assertRaisesRegex(ValueError, "filename"):
            METADATA.release_metadata("v1.0.0", self.notes_file("v1.0.3", "notes"))

    def test_cli_prints_safe_json_and_appends_only_fixed_github_fields(self):
        notes = self.notes_file("v1.0.1-beta.3", "<!-- orbis-update-priority: critical -->\nsecret body text")
        output = Path(self.temp.name) / "github-output"
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--tag", "v1.0.1-beta.3", "--notes", str(notes), "--github-output", str(output)],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        parsed = json.loads(result.stdout)
        self.assertEqual(parsed["priority"], "critical")
        self.assertNotIn("secret body text", result.stdout)
        self.assertEqual(output.read_text(encoding="utf-8").splitlines(), [
            "tag=v1.0.1-beta.3", "displayVersion=1.0.1 beta 3", "channel=nightly", "prerelease=true",
            "priority=critical", "kind=maintenance",
        ])


if __name__ == "__main__":
    unittest.main()
