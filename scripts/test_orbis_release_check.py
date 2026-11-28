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
QUALIFIED_ASSET = ASSET.rsplit('/', 1)[0] + '/qualified-release-manifest.json'


class OrbisReleaseCheckTests(unittest.TestCase):
    def test_unpublished_tag_families_are_rejected_before_network_discovery(self):
        with patch.object(CHECK, "published_release") as discover:
            for tag in ["v0.1.0-nightly.20261025", "v0.1.0-dev.1", "v0.1.0-alpha.1", "v01.0.0", "v0.1.0-rc.01"]:
                with self.subTest(tag=tag), self.assertRaisesRegex(ValueError, "published Stable or Nightly release"):
                    CHECK.check(tag)
            discover.assert_not_called()

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

    def test_accepts_only_the_qualified_manifest_slot_for_a_coordinated_release(self):
        legacy = {"name": "release-manifest.json", "browser_download_url": ASSET}
        qualified = {"name": "qualified-release-manifest.json", "browser_download_url": QUALIFIED_ASSET}
        release = {"tag_name": TAG, "draft": False, "assets": [qualified]}
        self.assertEqual(CHECK.release_asset(release, TAG), QUALIFIED_ASSET)
        with self.assertRaisesRegex(ValueError, "manifest asset"):
            CHECK.release_asset({**release, "assets": [legacy, qualified]}, TAG)
        with self.assertRaisesRegex(ValueError, "manifest asset"):
            CHECK.release_asset({**release, "assets": [{**qualified, "browser_download_url": ASSET}]}, TAG)

    def test_qualified_slot_is_only_for_the_supported_new_compatibility_base(self):
        manifest = {"schema": "orbis.release.v1", "image": CHECK.PLAN.IMAGE, "tag": TAG,
                    "commit": "a" * 40, "digest": "sha256:" + "c" * 64,
                    "runtipiCompatibility": "4.12.0", "installationProtocol": "orbis.installation-state.v1"}
        absent = HTTPError(ASSET, 404, "missing", {}, None)
        with patch.object(CHECK, "read_json", side_effect=(absent, manifest)) as read:
            self.assertEqual(CHECK.read_manifest(ASSET, True), manifest)
            self.assertEqual([call.args[0] for call in read.call_args_list], [ASSET, QUALIFIED_ASSET])
        with patch.object(CHECK, "read_json", return_value={**manifest, "runtipiCompatibility": "4.10.1"}):
            with self.assertRaisesRegex(ValueError, "wrong compatibility base"):
                CHECK.read_manifest(QUALIFIED_ASSET, False)
        for status, fallback in ((404, False), (403, True), (503, True)):
            error = HTTPError(ASSET, status, "denied or unavailable", {}, None)
            self.addCleanup(error.close)
            with self.subTest(status=status, fallback=fallback), patch.object(CHECK, "read_json", side_effect=error) as read:
                with self.assertRaises(HTTPError):
                    CHECK.read_manifest(ASSET, fallback)
                read.assert_called_once_with(ASSET, 16 * 1024)

    def test_public_release_fallback_after_anonymous_api_rate_limit(self):
        with patch.object(CHECK, "read_json", side_effect=HTTPError(CHECK.GITHUB_API, 403, "rate limit", {}, None)), \
             patch.object(CHECK, "git_tag_commit", return_value="a" * 40), \
             patch.object(CHECK, "read_url", return_value=(b"# Published notes", {})):
            asset, commit, published, notes, fallback = CHECK.published_release(TAG)
        self.assertEqual(asset, ASSET)
        self.assertEqual(commit, "a" * 40)
        self.assertIsNone(published)
        self.assertEqual(notes, "# Published notes")
        self.assertTrue(fallback)

    def test_temporary_api_errors_use_the_same_git_and_tagged_notes_verification(self):
        for code in (429, 500, 502, 503, 504):
            with self.subTest(code=code), \
                 patch.object(CHECK, "read_json", side_effect=HTTPError(CHECK.GITHUB_API, code, "unavailable", {}, None)), \
                 patch.object(CHECK, "git_tag_commit", return_value="a" * 40) as git, \
                 patch.object(CHECK, "read_url", return_value=(b"# Published notes", {})) as notes:
                self.assertEqual(CHECK.published_release(TAG), (ASSET, "a" * 40, None, "# Published notes", True))
                git.assert_called_once_with(TAG)
                notes.assert_called_once_with(f"https://raw.githubusercontent.com/twentylines/orbis/{TAG}/releases/{TAG}.md", 64 * 1024)

    def test_permanent_api_errors_do_not_fall_back(self):
        for code in (400, 401, 404, 410, 501):
            error = HTTPError(CHECK.GITHUB_API, code, "rejected", {}, None)
            self.addCleanup(error.close)
            with self.subTest(code=code), patch.object(CHECK, "read_json", side_effect=error), \
                 patch.object(CHECK, "git_tag_commit") as git, patch.object(CHECK, "read_url") as read:
                with self.assertRaises(HTTPError) as raised:
                    CHECK.published_release(TAG)
                self.assertIs(raised.exception, error)
                git.assert_not_called()
                read.assert_not_called()

    def test_api_outage_fallback_still_rejects_manifest_commit_mismatch(self):
        manifest = {"schema": "orbis.release.v1", "image": CHECK.PLAN.IMAGE, "tag": TAG,
                    "commit": "a" * 40, "digest": "sha256:" + "c" * 64, "runtipiCompatibility": "4.10.1"}
        with patch.object(CHECK, "read_json", side_effect=[HTTPError(CHECK.GITHUB_API, 504, "unavailable", {}, None), manifest]), \
             patch.object(CHECK, "git_tag_commit", return_value="b" * 40), \
             patch.object(CHECK, "read_url", return_value=(b"# Published notes", {})) as read:
            with self.assertRaisesRegex(ValueError, "commit did not match"):
                CHECK.check(TAG)
            self.assertEqual(read.call_count, 1)

    def test_api_outage_does_not_turn_a_missing_public_asset_into_a_release(self):
        absent = HTTPError(ASSET, 404, "missing", {}, None)
        qualified_absent = HTTPError(QUALIFIED_ASSET, 404, "missing", {}, None)
        self.addCleanup(qualified_absent.close)
        with patch.object(CHECK, "read_json",
                          side_effect=[HTTPError(CHECK.GITHUB_API, 503, "unavailable", {}, None), absent, qualified_absent]), \
             patch.object(CHECK, "git_tag_commit", return_value="a" * 40), \
             patch.object(CHECK, "read_url", return_value=(b"# Published notes", {})):
            with self.assertRaises(HTTPError) as raised:
                CHECK.check(TAG)
            self.assertIs(raised.exception, qualified_absent)

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

    def test_checked_release_reports_the_published_installation_protocol(self):
        body = json.dumps({"mediaType": "application/vnd.oci.image.index.v1+json", "manifests": [
            {"platform": {"os": "linux", "architecture": "amd64"}},
            {"platform": {"os": "linux", "architecture": "arm64"}},
        ]}).encode()
        digest = "sha256:" + hashlib.sha256(body).hexdigest()
        manifest = {"schema": "orbis.release.v1", "image": CHECK.PLAN.IMAGE, "tag": TAG,
                    "commit": "a" * 40, "digest": digest, "runtipiCompatibility": "4.10.1",
                    "installationProtocol": CHECK.PLAN.INSTALLATION_PROTOCOL}
        with patch.object(CHECK, "published_release", return_value=(ASSET, manifest["commit"], None, "Notes", False)), \
             patch.object(CHECK, "read_json", side_effect=[manifest, {"token": "public-pull-token"}]), \
             patch.object(CHECK, "read_url", return_value=(body, {"docker-content-digest": digest})):
            self.assertEqual(CHECK.check(TAG)["installationProtocol"], CHECK.PLAN.INSTALLATION_PROTOCOL)


if __name__ == "__main__":
    unittest.main()
