import hashlib
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError


SPEC = importlib.util.spec_from_file_location("orbis_release_check", Path(__file__).with_name("orbis-release-check.py"))
assert SPEC and SPEC.loader
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)

TAG = "v0.1.0-beta.5"
ASSET = f"https://github.com/twentylines/orbis/releases/download/{TAG}/release-manifest.json"


class OrbisReleaseCheckTests(unittest.TestCase):
    def test_requires_published_matching_github_asset(self):
        release = {"tag_name": TAG, "draft": False, "assets": [{"name": "release-manifest.json", "browser_download_url": ASSET}]}
        self.assertEqual(CHECK.release_asset(release, TAG), ASSET)
        with self.assertRaisesRegex(ValueError, "publication"):
            CHECK.release_asset({**release, "draft": True}, TAG)
        with self.assertRaisesRegex(ValueError, "manifest asset"):
            CHECK.release_asset({**release, "assets": [{"name": "release-manifest.json", "browser_download_url": "https://example.test/bad"}]}, TAG)

    def test_resolves_annotated_tag_to_commit(self):
        commit = "a" * 40
        ref = {"object": {"type": "tag", "sha": "b" * 40}}
        self.assertEqual(CHECK.tag_commit(ref, {"object": {"type": "commit", "sha": commit}}), commit)
        with self.assertRaisesRegex(ValueError, "annotated"):
            CHECK.tag_commit(ref)

    def test_public_release_fallback_after_anonymous_api_rate_limit(self):
        with patch.object(CHECK, "read_json", side_effect=HTTPError(CHECK.GITHUB_API, 403, "rate limit", {}, None)), \
             patch.object(CHECK, "git_tag_commit", return_value="a" * 40), \
             patch.object(CHECK, "read_url", return_value=(b"# Published notes", {})):
            asset, commit, published, notes = CHECK.published_release(TAG)
        self.assertEqual(asset, ASSET)
        self.assertEqual(commit, "a" * 40)
        self.assertIsNone(published)
        self.assertEqual(notes, "# Published notes")

    def test_checks_index_body_digest_header_and_platforms(self):
        index = {
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {"platform": {"os": "linux", "architecture": "amd64"}},
                {"platform": {"os": "linux", "architecture": "arm64"}},
                {"platform": {"os": "unknown", "architecture": "unknown"}},
            ],
        }
        body = json.dumps(index).encode()
        digest = "sha256:" + hashlib.sha256(body).hexdigest()
        self.assertEqual(CHECK.verify_index(body, digest, digest), ["linux/amd64", "linux/arm64"])
        with self.assertRaisesRegex(ValueError, "digest"):
            CHECK.verify_index(body, "sha256:" + "0" * 64, digest)
        index["manifests"].pop(1)
        body = json.dumps(index).encode()
        digest = "sha256:" + hashlib.sha256(body).hexdigest()
        with self.assertRaisesRegex(ValueError, "platform"):
            CHECK.verify_index(body, digest, digest)


if __name__ == "__main__":
    unittest.main()
