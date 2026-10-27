import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("orbis_release_watermark", Path(__file__).with_name("orbis-release-watermark.py"))
assert SPEC and SPEC.loader
WATERMARK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WATERMARK)


class ReleaseWatermarkTests(unittest.TestCase):
    def compute(self, tag, channel, priority="normal", inherited=()):
        return WATERMARK.compute_critical_through(tag, channel, priority, list(inherited))

    def test_current_critical_starts_the_durable_marker(self):
        self.assertEqual(self.compute("v1.1.2", "stable", "critical"), "v1.1.2")
        self.assertEqual(self.compute("v1.1.2-beta.9", "nightly", "critical"), "v1.1.2-beta.9")

    def test_current_critical_does_not_depend_on_release_history_availability(self):
        with patch.object(WATERMARK, "tag_commit", return_value="a" * 40), \
             patch.object(WATERMARK, "inherited_markers", side_effect=AssertionError("Unnecessary release history request")):
            self.assertEqual(WATERMARK.compute("v1.1.2", "stable", "critical", "a" * 40, "twentylines/orbis", "declared-test-token"), ("v1.1.2", ["v1.1.2"]))

    def test_discovery_reads_only_the_newest_authoritative_marker_per_channel(self):
        releases = [{"tag_name": "v1.1.1"}, {"tag_name": "v1.1.3"}, {"tag_name": "v1.1.2"}]
        with patch.object(WATERMARK, "release_pages", return_value=releases), \
             patch.object(WATERMARK, "is_ancestor", return_value=True), \
             patch.object(WATERMARK, "tag_commit", return_value="a" * 40), \
             patch.object(WATERMARK, "previous_manifest", return_value={"criticalThrough": "v1.1.2"}) as read_manifest:
            self.assertEqual(WATERMARK.inherited_markers("v1.1.4", "a" * 40, "twentylines/orbis", "declared-test-token"),
                             [
                                 {"channel": "stable", "criticalThrough": "v1.1.2", "ancestor": True},
                                 {"tag": "v1.1.2", "channel": "stable", "ancestor": True, "newlyIntroduced": False},
                             ])
            self.assertEqual(read_manifest.call_count, 1)
            self.assertEqual(read_manifest.call_args.args[0]["tag_name"], "v1.1.3")

    def test_new_stable_fix_is_introduced_to_advanced_nightly_since_its_prior_source(self):
        releases = [
            {"tag_name": "v1.1.2", "assets": []},
            {"tag_name": "v1.2.0-beta.10", "assets": []},
        ]
        manifests = {
            "v1.1.2": {"criticalThrough": "v1.1.2", "criticalFixes": ["v1.1.2"]},
            "v1.2.0-beta.10": {"criticalThrough": "v1.2.0-beta.9", "criticalFixes": ["v1.2.0-beta.8"]},
        }
        def manifest_for(release, *_args):
            return manifests[release["tag_name"]]
        def ancestor(tag, commit):
            if commit == "c" * 40:
                return tag in {"v1.1.2", "v1.2.0-beta.10", "v1.2.0-beta.9", "v1.2.0-beta.8"}
            return tag == "v1.2.0-beta.8" and commit == "b" * 40
        with patch.object(WATERMARK, "release_pages", return_value=releases), \
             patch.object(WATERMARK, "previous_manifest", side_effect=manifest_for), \
             patch.object(WATERMARK, "tag_commit", side_effect=lambda tag: "a" * 40 if tag == "v1.1.2" else "b" * 40), \
             patch.object(WATERMARK, "is_ancestor", side_effect=ancestor):
            inherited = WATERMARK.inherited_markers("v1.2.0-beta.11", "c" * 40, "owner/repo", "test-token")
        stable_fix = next(item for item in inherited if item.get("tag") == "v1.1.2")
        self.assertTrue(stable_fix["newlyIntroduced"])
        self.assertEqual(self.compute("v1.2.0-beta.11", "nightly", inherited=inherited), "v1.2.0-beta.11")

    def test_discovery_does_not_repromote_a_known_stable_fix_or_same_commit_nightly_fix(self):
        releases = [
            {"tag_name": "v1.1.3", "assets": []},
            {"tag_name": "v1.2.0-beta.10", "assets": []},
        ]
        manifests = {
            "v1.1.3": {"criticalThrough": "v1.1.3", "criticalFixes": ["v1.1.2", "v1.2.0-beta.4"]},
            "v1.2.0-beta.10": {"criticalThrough": "v1.2.0-beta.10", "criticalFixes": ["v1.2.0-beta.4"]},
        }
        def ancestor(tag, commit):
            if commit in {"c" * 40, "b" * 40}:
                return tag in {"v1.1.3", "v1.1.2", "v1.2.0-beta.10", "v1.2.0-beta.4"}
            return False
        with patch.object(WATERMARK, "release_pages", return_value=releases), \
             patch.object(WATERMARK, "previous_manifest", side_effect=lambda release, *_args: manifests[release["tag_name"]]), \
             patch.object(WATERMARK, "tag_commit", side_effect=lambda tag: "a" * 40 if tag == "v1.1.3" else "b" * 40), \
             patch.object(WATERMARK, "is_ancestor", side_effect=ancestor):
            inherited = WATERMARK.inherited_markers("v1.2.0-beta.11", "c" * 40, "owner/repo", "test-token")
        nightly_fix = next(item for item in inherited if item.get("tag") == "v1.2.0-beta.4")
        self.assertFalse(nightly_fix["newlyIntroduced"])
        self.assertEqual(self.compute("v1.2.0-beta.11", "nightly", inherited=inherited), "v1.2.0-beta.10")

    def test_first_stable_release_promotes_nightly_fix_even_when_source_commit_is_the_same(self):
        commit = "a" * 40
        releases = [{
            "tag_name": "v0.1.0-beta.114",
            "draft": False,
            "body": "<!-- orbis-update-priority: critical -->\n# Critical fix\n",
            "assets": [],
        }]
        with patch.object(WATERMARK, "release_pages", return_value=releases), \
             patch.object(WATERMARK, "tag_commit", return_value=commit), \
             patch.object(WATERMARK, "is_ancestor", return_value=True), \
             patch.object(WATERMARK, "previous_manifest", side_effect=AssertionError("Critical notes supply the source frontier")):
            inherited = WATERMARK.inherited_markers("v0.1.0", commit, "owner/repo", "test-token")
        fix = next(item for item in inherited if item.get("tag") == "v0.1.0-beta.114")
        self.assertTrue(fix["newlyIntroduced"])
        self.assertEqual(self.compute("v0.1.0", "stable", inherited=inherited), "v0.1.0")

    def test_normal_beta115_bootstraps_from_published_critical_beta114_without_a_frontier_asset(self):
        commit = "a" * 40
        releases = [{
            "tag_name": "v0.1.0-beta.114",
            "draft": False,
            "body": "<!-- orbis-update-priority: critical -->\n# Critical fix\n",
            "assets": [],
        }]
        with patch.object(WATERMARK, "release_pages", return_value=releases), \
             patch.object(WATERMARK, "tag_commit", return_value=commit), \
             patch.object(WATERMARK, "is_ancestor", return_value=True), \
             patch.object(WATERMARK, "previous_manifest", side_effect=AssertionError("The published beta114 note is authoritative")):
            inherited = WATERMARK.inherited_markers("v0.1.0-beta.115", commit, "owner/repo", "test-token")
        marker, fixes = WATERMARK.compute_release_state("v0.1.0-beta.115", "nightly", "normal", inherited)
        self.assertEqual(marker, "v0.1.0-beta.114")
        self.assertEqual(fixes, ["v0.1.0-beta.114"])

    def test_stable_patch_carries_a_known_nightly_fix_without_promoting_again(self):
        target_commit = "c" * 40
        stable_commit = "b" * 40
        nightly_commit = "a" * 40
        releases = [
            {"tag_name": "v1.2.0", "draft": False, "assets": []},
            {"tag_name": "v1.2.0-beta.114", "draft": False, "assets": []},
        ]
        manifests = {
            "v1.2.0": {"criticalThrough": "v1.2.0", "criticalFixes": ["v1.2.0-beta.114"]},
            "v1.2.0-beta.114": {"criticalThrough": "v1.2.0-beta.114", "criticalFixes": ["v1.2.0-beta.114"]},
        }
        commits = {"v1.2.0": stable_commit, "v1.2.0-beta.114": nightly_commit}
        def ancestor(tag, commit):
            if commit == target_commit:
                return tag in {"v1.2.0", "v1.2.0-beta.114"}
            return tag == "v1.2.0-beta.114" and commit == stable_commit
        with patch.object(WATERMARK, "release_pages", return_value=releases), \
             patch.object(WATERMARK, "previous_manifest", side_effect=lambda release, *_args: manifests[release["tag_name"]]), \
             patch.object(WATERMARK, "tag_commit", side_effect=lambda tag: commits[tag]), \
             patch.object(WATERMARK, "is_ancestor", side_effect=ancestor):
            inherited = WATERMARK.inherited_markers("v1.2.1", target_commit, "owner/repo", "test-token")
        nightly_fix = next(item for item in inherited if item.get("tag") == "v1.2.0-beta.114")
        self.assertFalse(nightly_fix["newlyIntroduced"])
        self.assertEqual(self.compute("v1.2.1", "stable", inherited=inherited), "v1.2.0")

    def test_old_null_marker_without_frontier_keeps_searching_legacy_history(self):
        release = {"tag_name": "v1.1.3", "assets": []}
        metadata = {
            "schema": "orbis.release.v1", "image": "ghcr.io/twentylines/orbis", "tag": "v1.1.3",
            "commit": "a" * 40, "criticalThrough": None, "updatePriority": "normal",
        }
        with patch.object(WATERMARK, "github_json", return_value=metadata), \
             patch.object(WATERMARK, "tag_commit", return_value="a" * 40):
            self.assertIsNone(WATERMARK.previous_manifest(release, "owner/repo", "test-token", "stable"))

    def test_nightly_carries_critical_stable_and_nightly_ancestors(self):
        inherited = [
            {"tag": "v1.1.2", "channel": "stable", "ancestor": True, "newlyIntroduced": False},
            {"tag": "v1.1.2-beta.9", "channel": "nightly", "ancestor": True, "newlyIntroduced": False},
            {"channel": "nightly", "criticalThrough": "v1.1.2-beta.9", "ancestor": True},
        ]
        self.assertEqual(self.compute("v1.1.2-beta.10", "nightly", inherited=inherited), "v1.1.2-beta.9")

    def test_semantic_max_is_independent_of_channel_marker_order(self):
        inherited = [
            {"tag": "v1.1.2", "channel": "stable", "ancestor": True},
            {"tag": "v1.1.3-beta.5", "channel": "nightly", "ancestor": True},
            {"channel": "nightly", "criticalThrough": "v1.1.3-beta.5", "ancestor": True},
        ]
        self.assertEqual(self.compute("v1.2.0-beta.1", "nightly", inherited=inherited), "v1.1.3-beta.5")

    def test_stable_carries_stable_marker_and_promotes_ancestor_nightly_fix(self):
        inherited_stable = [
            {"tag": "v1.1.2", "channel": "stable", "ancestor": True, "newlyIntroduced": False},
            {"channel": "stable", "criticalThrough": "v1.1.2", "ancestor": True},
        ]
        self.assertEqual(self.compute("v1.1.3", "stable", inherited=inherited_stable), "v1.1.2")
        inherited_nightly = [
            {"tag": "v1.1.3-beta.2", "channel": "nightly", "ancestor": True, "newlyIntroduced": True},
            {"channel": "stable", "criticalThrough": "v1.1.2", "ancestor": True},
        ]
        self.assertEqual(self.compute("v1.1.3", "stable", inherited=inherited_nightly), "v1.1.3")

    def test_stable_backport_promotes_once_and_preserves_the_prior_frontier(self):
        inherited_first = [
            {"tag": "v1.1.2", "channel": "stable", "ancestor": True, "newlyIntroduced": False},
            {"tag": "v1.2.0-beta.4", "channel": "nightly", "ancestor": True, "newlyIntroduced": True},
            {"channel": "stable", "criticalThrough": "v1.1.2", "ancestor": True},
        ]
        self.assertEqual(self.compute("v1.1.3", "stable", inherited=inherited_first), "v1.1.3")
        inherited_next = [
            {"tag": "v1.1.2", "channel": "stable", "ancestor": True, "newlyIntroduced": False},
            {"tag": "v1.2.0-beta.4", "channel": "nightly", "ancestor": True, "newlyIntroduced": False},
            {"channel": "stable", "criticalThrough": "v1.1.3", "ancestor": True},
        ]
        self.assertEqual(self.compute("v1.1.4", "stable", inherited=inherited_next), "v1.1.3")

    def test_new_lower_stable_backport_promotes_advanced_nightly_once(self):
        inherited = [
            {"tag": "v1.1.2", "channel": "stable", "ancestor": True, "newlyIntroduced": True},
            {"tag": "v1.2.0-beta.10", "channel": "nightly", "ancestor": True, "newlyIntroduced": False},
            {"channel": "nightly", "criticalThrough": "v1.2.0-beta.9", "ancestor": True},
        ]
        self.assertEqual(self.compute("v1.2.0-beta.11", "nightly", inherited=inherited), "v1.2.0-beta.11")

    def test_same_commit_promotion_does_not_create_a_new_critical_warning(self):
        inherited = [
            {"tag": "v1.1.2", "channel": "stable", "ancestor": True, "newlyIntroduced": False},
            {"channel": "nightly", "criticalThrough": "v1.2.0-beta.10", "ancestor": True},
        ]
        self.assertEqual(self.compute("v1.2.0-beta.11", "nightly", inherited=inherited), "v1.2.0-beta.10")

    def test_frontier_prunes_ancestry_covered_origins_and_keeps_same_commit_once(self):
        commits = {"v1.1.1": "a" * 40, "v1.1.2": "b" * 40, "v1.1.2-beta.1": "b" * 40}
        with patch.object(WATERMARK, "tag_commit", side_effect=lambda tag: commits[tag]), \
             patch.object(WATERMARK, "is_ancestor", side_effect=lambda tag, commit: tag in commits and commits[tag] == commit or tag == "v1.1.1" and commit == "b" * 40):
            self.assertEqual(WATERMARK.prune_fix_frontier(["v1.1.1", "v1.1.2", "v1.1.2-beta.1"]), ["v1.1.2"])

    def test_unrelated_future_and_cross_channel_markers_are_ignored(self):
        inherited = [
            {"tag": "v1.1.3", "channel": "stable", "ancestor": False},
            {"tag": "v1.2.0-beta.1", "channel": "nightly", "ancestor": True},
        ]
        self.assertIsNone(self.compute("v1.1.2", "stable", inherited=inherited))
        with self.assertRaises(ValueError):
            self.compute("v1.1.2-beta.1", "stable")

    def test_invalid_inputs_are_rejected(self):
        with self.assertRaises(ValueError):
            self.compute("v1.1.02", "stable")
        with self.assertRaises(ValueError):
            self.compute("v1.1.2", "stable", "urgent")

    def test_legacy_priority_headers_are_preserved_without_body_heuristics(self):
        self.assertEqual(WATERMARK.release_body_priority("<!-- orbis-update-priority: critical -->\n<!-- orbis-release-kind: feature -->\n- Fix"), "critical")
        self.assertEqual(WATERMARK.release_body_priority("- critical release wording only"), "normal")

    def test_generated_watermark_follows_the_two_legacy_metadata_headers(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.md"
            output = Path(directory) / "release.md"
            source.write_text("<!-- orbis-update-priority: critical -->\n<!-- orbis-release-kind: maintenance -->\n# Fix\n", encoding="utf-8")
            WATERMARK.append_marker(source, output, "v1.1.2")
            self.assertEqual(
                output.read_text(encoding="utf-8"),
                "<!-- orbis-update-priority: critical -->\n<!-- orbis-release-kind: maintenance -->\n<!-- orbis-critical-through: v1.1.2 -->\n# Fix\n",
            )

    def test_discovery_skips_drafts_and_newer_tags_and_selects_source_bound_manifests(self):
        releases = [
            {"tag_name": "v1.1.4", "draft": True, "assets": []},
            {"tag_name": "v1.2.0", "draft": False, "assets": [], "body": "<!-- orbis-update-priority: critical -->\n"},
            {"tag_name": "v1.1.3", "draft": False, "assets": [{"name": "release-manifest.json", "id": 31}]},
            {"tag_name": "v1.1.3-beta.9", "draft": False, "assets": [{"name": "release-manifest.json", "id": 32}]},
        ]
        manifests = {
            31: {
                "schema": "orbis.release.v1", "image": "ghcr.io/twentylines/orbis", "tag": "v1.1.3",
                "commit": "a" * 40, "releaseChannel": "stable", "updatePriority": "normal", "criticalThrough": "v1.1.2", "criticalFixes": ["v1.1.2"],
            },
            32: {
                "schema": "orbis.release.v1", "image": "ghcr.io/twentylines/orbis", "tag": "v1.1.3-beta.9",
                "commit": "a" * 40, "releaseChannel": "nightly", "updatePriority": "normal", "criticalThrough": "v1.1.3-beta.5", "criticalFixes": ["v1.1.3-beta.5"],
            },
        }

        def fake_api(url, _token, _limit):
            if "/releases?" in url:
                return releases
            return manifests[int(url.rsplit("/", 1)[1])]

        with patch.object(WATERMARK, "github_json", side_effect=fake_api), \
             patch.object(WATERMARK, "tag_commit", return_value="a" * 40), \
             patch.object(WATERMARK, "is_ancestor", return_value=True):
            inherited = WATERMARK.inherited_markers("v1.2.0-beta.1", "a" * 40, "owner/repo", "test-token")
        self.assertEqual({(entry.get("tag"), entry.get("channel"), entry.get("criticalThrough")) for entry in inherited}, {
            ("v1.1.2", "stable", None),
            ("v1.1.3-beta.5", "nightly", None),
            (None, "nightly", "v1.1.3-beta.5"),
        })
        self.assertEqual(self.compute("v1.2.0-beta.1", "nightly", inherited=inherited), "v1.1.3-beta.5")

    def test_discovery_propagates_api_and_ancestry_failures(self):
        with patch.object(WATERMARK, "github_json", side_effect=ValueError("GitHub unavailable")):
            with self.assertRaisesRegex(ValueError, "GitHub unavailable"):
                WATERMARK.inherited_markers("v1.1.4", "a" * 40, "owner/repo", "test-token")
        with patch.object(WATERMARK, "release_pages", return_value=[{"tag_name": "v1.1.3", "assets": []}]), \
             patch.object(WATERMARK, "is_ancestor", side_effect=ValueError("ancestry unavailable")):
            with self.assertRaisesRegex(ValueError, "ancestry unavailable"):
                WATERMARK.inherited_markers("v1.1.4", "a" * 40, "owner/repo", "test-token")

    def test_discovery_ignores_draft_and_unrelated_critical_releases(self):
        releases = [
            {"tag_name": "v1.1.3", "draft": True, "body": "<!-- orbis-update-priority: critical -->\n", "assets": []},
            {"tag_name": "v1.1.2", "draft": False, "body": "<!-- orbis-update-priority: critical -->\n", "assets": []},
        ]
        with patch.object(WATERMARK, "release_pages", return_value=releases), \
             patch.object(WATERMARK, "is_ancestor", side_effect=lambda candidate, _commit: candidate != "v1.1.2"), \
             patch.object(WATERMARK, "previous_manifest") as previous_manifest:
            inherited = WATERMARK.inherited_markers("v1.1.4", "a" * 40, "owner/repo", "test-token")
        self.assertEqual(inherited, [])
        previous_manifest.assert_not_called()


if __name__ == "__main__":
    unittest.main()
