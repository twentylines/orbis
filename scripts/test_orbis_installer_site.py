import copy
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("installer_site", Path(__file__).with_name("publish-installer-site.py"))
SITE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SITE)


class InstallerEndpointTests(unittest.TestCase):
    def setUp(self):
        self.release = {"schema": "orbis.release.v1", "image": "ghcr.io/twentylines/orbis", "tag": "v1.0.0", "commit": "a" * 40, "digest": "sha256:" + "b" * 64, "installationProtocol": "orbis.installation-state.v1", "runtipiCompatibility": "4.10.1"}
        self.files = {name: b"# public source\n" for name in SITE.BUILD.REQUIRED}
        self.files["scripts/install-orbis.py"] = Path(__file__).with_name("install-orbis.py").read_bytes()
        self.files["scripts/orbis-installer-bundle.py"] = ("REQUIRED = " + repr(SITE.BUILD.REQUIRED)).encode()
        self.assets = {**SITE.BUILD.build(self.files, json.dumps(self.release).encode()), "release-manifest.json": json.dumps(self.release).encode()}
        self.selected = self.record(self.release["tag"])
        self.selected["assets"] = [{"name": name, "browser_download_url": SITE.BASE + "download/" + self.selected["tag_name"] + "/" + name, "state": "uploaded", "size": len(data), "digest": "sha256:" + SITE.BUILD.sha(data)} for name, data in self.assets.items()]
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / "site"

    def record(self, tag, *, draft=False):
        return {"name": "Orbis release " + tag.removeprefix("v"), "tag_name": tag, "draft": draft, "published_at": "2026-10-23T00:00:00Z", "html_url": SITE.BASE + "tag/" + tag, "assets": []}

    def publish(self, releases=None, assets=None, commit=None, *, channel="stable"):
        assets = self.assets if assets is None else assets
        def fetch(url, limit):
            content = assets[url.rsplit("/", 1)[1]]
            self.assertLessEqual(len(content), limit)
            return content
        with mock.patch.object(SITE, "tag_commit", return_value=commit or self.release["commit"]), mock.patch.object(SITE.BUILD, "committed_files", return_value=self.files):
            return SITE.site(Path(self.temp.name), releases or [self.selected], self.output, fetch, channel=channel)

    def test_default_stable_selects_final_and_nightly_orders_prereleases_semantically(self):
        rows = [self.record(tag) for tag in ["v0.1.0-beta.9", "v0.1.0-beta.68", "v0.1.0-beta.10"]]
        rows += [self.record("v9.0.0", draft=True)]
        rows += [self.record("v0.1.0")]
        rows += [self.record("v0.2.0-beta.1")]
        self.assertEqual(SITE.newest(rows)["tag_name"], "v0.1.0")
        self.assertEqual(SITE.newest(rows, "nightly")["tag_name"], "v0.2.0-beta.1")
        betas = [self.record(tag) for tag in ["v0.1.0-beta.9", "v0.1.0-beta.68", "v0.1.0-beta.10"]]
        self.assertEqual(SITE.newest(betas, "nightly")["tag_name"], "v0.1.0-beta.68")

    def test_no_stable_release_does_not_fall_back_to_beta_and_malformed_tags_are_excluded(self):
        rows = [self.record(tag) for tag in ["v1.0.1-beta.1", "v1.0.0-nightly.20261027", "v01.0.0", "v1.0.0-beta.01"]]
        with self.assertRaisesRegex(ValueError, "No published Stable"):
            SITE.newest(rows)
        self.assertEqual(SITE.newest(rows, "nightly")["tag_name"], "v1.0.1-beta.1")

    def run_cli(self, releases, *options):
        source = Path(self.temp.name) / "releases.json"
        source.write_text(json.dumps(releases))
        log = io.StringIO()
        with redirect_stdout(log):
            SITE.main([str(source), str(self.output), *options])
        return json.loads(log.getvalue())

    def test_optional_missing_stable_preserves_existing_endpoint_without_fetching_beta(self):
        self.output.mkdir()
        launcher = self.output / "install"
        launcher.write_bytes(b"previous verified launcher")
        outputs = Path(self.temp.name) / "workflow-output"
        with mock.patch.object(SITE.BOOT, "fetch", side_effect=AssertionError("must not fetch a beta")):
            result = self.run_cli([self.record("v1.0.0-beta.1")], "--if-available", "--github-output", str(outputs))
        self.assertEqual(result["available"], False)
        self.assertEqual(outputs.read_text(), "available=false\n")
        self.assertEqual(launcher.read_bytes(), b"previous verified launcher")
        self.assertEqual({p.name for p in self.output.iterdir()}, {"install"})

    def test_missing_channel_still_fails_without_explicit_optional_flag(self):
        with self.assertRaises(SITE.NoPublishedRelease):
            self.run_cli([self.record("v1.0.0-beta.1")])
        self.assertFalse(self.output.exists())

    def test_optional_missing_channel_never_hides_invalid_data_or_unverified_assets(self):
        outputs = Path(self.temp.name) / "workflow-output"
        for rows in [{}, [self.record("v1.0.0")]]:
            with self.subTest(rows=type(rows).__name__), self.assertRaises(ValueError):
                self.run_cli(rows, "--if-available", "--github-output", str(outputs))
            self.assertFalse(outputs.exists())
            self.assertFalse(self.output.exists())

    def test_workflow_availability_is_true_only_after_verification_finishes(self):
        outputs = Path(self.temp.name) / "workflow-output"
        with mock.patch.object(SITE, "site", return_value={"channel": "stable", "tag": "v1.0.0"}) as publish:
            result = self.run_cli([self.selected], "--if-available", "--github-output", str(outputs))
        publish.assert_called_once()
        self.assertTrue(result["available"])
        self.assertEqual(outputs.read_text(), "available=true\n")

    def test_serves_exact_release_launcher_and_only_explicit_public_outputs(self):
        (Path(self.temp.name) / "HANDOFF.md").write_text("private notes")
        (Path(self.temp.name) / ".env").write_text("private environment")
        result = self.publish()
        self.assertEqual(result["tag"], self.release["tag"])
        self.assertEqual(result["channel"], "stable")
        self.assertEqual((self.output / "install").read_bytes(), self.assets["install-orbis.py"])
        channel = json.loads((self.output / "latest.json").read_text())
        self.assertEqual(channel["channel"], "stable")
        self.assertEqual(channel["commit"], self.release["commit"])
        self.assertEqual(channel["launcherSha256"], SITE.BUILD.sha((self.output / "install").read_bytes()))
        self.assertEqual({p.name for p in self.output.iterdir()}, {"install", "latest.json", "index.html", ".nojekyll"})

    def test_older_source_bound_packages_use_their_original_required_file_list(self):
        required = SITE.BUILD.REQUIRED - {"scripts/orbis-install-ui.py"}
        del self.files["scripts/orbis-install-ui.py"]
        self.files["scripts/orbis-installer-bundle.py"] = ("REQUIRED = " + repr(required)).encode()
        with mock.patch.object(SITE.BUILD, "REQUIRED", required):
            assets = {**SITE.BUILD.build(self.files, self.assets["release-manifest.json"]), "release-manifest.json": self.assets["release-manifest.json"]}
        selected = copy.deepcopy(self.selected)
        for item in selected["assets"]:
            data = assets[item["name"]]; item.update(size=len(data), digest="sha256:" + SITE.BUILD.sha(data))
        self.publish([selected], assets)
        self.assertEqual((self.output / "install").read_bytes(), assets["install-orbis.py"])

    def test_incomplete_newest_release_never_falls_back_to_an_older_installer(self):
        newer = self.record("v1.0.1-beta.69")
        with self.assertRaisesRegex(ValueError, "missing a unique"):
            self.publish([self.selected, newer], channel="nightly")
        self.assertFalse(self.output.exists())

    def test_corrupt_asset_or_digest_is_rejected_before_public_output(self):
        for field, value in [("digest", "sha256:" + "0" * 64), ("size", True), ("state", "new"), ("browser_download_url", "https://example.test/install.py")]:
            selected = copy.deepcopy(self.selected); selected["assets"][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.publish([selected])
            self.assertFalse(self.output.exists())

    def test_tampering_with_a_published_asset_still_fails_even_if_api_digest_matches(self):
        assets = {**self.assets, "install-orbis.py": self.assets["install-orbis.py"] + b"\nraise RuntimeError('altered')\n"}
        selected = copy.deepcopy(self.selected)
        item = next(item for item in selected["assets"] if item["name"] == "install-orbis.py")
        item.update(size=len(assets["install-orbis.py"]), digest="sha256:" + SITE.BUILD.sha(assets["install-orbis.py"]))
        with self.assertRaisesRegex(ValueError, "committed source"):
            self.publish([selected], assets)
        self.assertFalse(self.output.exists())

    def test_archive_contents_are_checked_against_git_even_if_all_download_hashes_match(self):
        changed = {**self.files, "scripts/orbis-install-ui.py": b"# altered runtime source\n"}
        assets = {**SITE.BUILD.build(changed, self.assets["release-manifest.json"]), "release-manifest.json": self.assets["release-manifest.json"]}
        selected = copy.deepcopy(self.selected)
        for item in selected["assets"]:
            data = assets[item["name"]]; item.update(size=len(data), digest="sha256:" + SITE.BUILD.sha(data))
        with self.assertRaisesRegex(ValueError, "committed source"):
            self.publish([selected], assets)
        self.assertFalse(self.output.exists())

    def test_compression_metadata_differences_do_not_change_verified_source_identity(self):
        archive = bytearray(self.assets[SITE.BUILD.ARCHIVE]); archive[4:8] = b"\x01\x00\x00\x00"
        manifest = json.loads(self.assets[SITE.BUILD.MANIFEST])
        manifest["archiveSha256"] = SITE.BUILD.sha(archive)
        manifest_bytes = json.dumps(manifest).encode()
        identity = {"tag": self.release["tag"], "commit": self.release["commit"], "manifestSha256": SITE.BUILD.sha(manifest_bytes)}
        assets = {**self.assets, SITE.BUILD.ARCHIVE: bytes(archive), SITE.BUILD.MANIFEST: manifest_bytes, SITE.BUILD.LAUNCHER: SITE.BUILD.release_launcher(self.files["scripts/install-orbis.py"], identity)}
        selected = copy.deepcopy(self.selected)
        for item in selected["assets"]:
            data = assets[item["name"]]; item.update(size=len(data), digest="sha256:" + SITE.BUILD.sha(data))
        self.publish([selected], assets)
        self.assertEqual((self.output / "install").read_bytes(), assets[SITE.BUILD.LAUNCHER])

    def test_tag_source_mismatch_and_foreign_repository_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "published Git tag"):
            self.publish(commit="f" * 40)
        selected = {**self.selected, "html_url": "https://github.com/other/orbis/releases/tag/v1.0.0"}
        with self.assertRaisesRegex(ValueError, "different repository"):
            self.publish([selected])
        self.assertFalse(self.output.exists())

    def test_duplicate_assets_and_missing_or_malformed_release_lists_fail(self):
        selected = copy.deepcopy(self.selected); selected["assets"].append(selected["assets"][0])
        with self.assertRaisesRegex(ValueError, "unique"):
            self.publish([selected])
        for value in [None, {}, [], [self.record("v1.0.0", draft=True)], [self.record("v0.1.0-beta.1")] * 101]:
            with self.subTest(value=type(value)), self.assertRaises(ValueError):
                SITE.newest(value)


if __name__ == "__main__":
    unittest.main()
