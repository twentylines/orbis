import copy
import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BUILD = load("orbis-installer-bundle")
BOOT = load("install-orbis")


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.release = {"schema": "orbis.release.v1", "image": "ghcr.io/twentylines/orbis", "tag": "v0.1.0-beta.65", "commit": "a" * 40, "digest": "sha256:" + "b" * 64, "installationProtocol": "orbis.installation-state.v1", "runtipiCompatibility": "4.10.1"}
        self.release_bytes = json.dumps(self.release).encode()
        self.files = {name: b"# owned test source\n" for name in BUILD.REQUIRED}
        self.files["scripts/install-orbis.py"] = Path(__file__).with_name("install-orbis.py").read_bytes()
        self.assets = BUILD.build(self.files, self.release_bytes)
        self.manifest = json.loads(self.assets[BUILD.MANIFEST])
        self.identity = {"tag": self.release["tag"], "commit": self.release["commit"], "manifestSha256": BUILD.sha(self.assets[BUILD.MANIFEST])}

    def validate_manifest_value(self, value):
        data = json.dumps(value).encode()
        identity = {**self.identity, "manifestSha256": BUILD.sha(data)}
        return BOOT.verify_manifest(data, identity)

    def tar(self, entries):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            for entry, content in entries:
                archive.addfile(entry, io.BytesIO(content) if content is not None else None)
        data = output.getvalue()
        return data, {**self.manifest, "archiveBytes": len(data), "archiveSha256": BUILD.sha(data)}

    def test_reproducible_archive_and_pinned_launcher(self):
        self.assertEqual(self.assets, BUILD.build(dict(reversed(list(self.files.items()))), self.release_bytes))
        namespace = {"__name__": "imported_release_launcher"}
        exec(compile(self.assets[BUILD.LAUNCHER], "release-launcher", "exec"), namespace)
        self.assertEqual(namespace["EXPECTED_RELEASE"], self.identity)
        manifest = BOOT.verify_manifest(self.assets[BUILD.MANIFEST], self.identity)
        self.assertEqual(BOOT.verify_files(self.assets[BUILD.ARCHIVE], manifest), {name: self.files[name] for name in BUILD.REQUIRED})

    def test_private_notes_credentials_tests_and_unrelated_files_are_never_packaged(self):
        files = {**self.files, "HANDOFF.md": b"private", "AGENTS.md": b"private", ".env": b"secret", "scripts/test_orbis_host.py": b"test", ".orbis-private/orbis-secret.py": b"secret", "screenshots/private.png": b"pixels"}
        self.assertEqual(self.assets, BUILD.build(files, self.release_bytes))

    def test_verified_real_package_can_import_every_installer_entry_point(self):
        root = Path(__file__).resolve().parent.parent
        files = {str(path.relative_to(root)): path.read_bytes() for path in (root / "scripts").glob("*.py") if BUILD.ALLOWED.fullmatch(str(path.relative_to(root)))}
        unit = "packaging/systemd/orbis-host.service"
        files[unit] = (root / unit).read_bytes()
        assets = BUILD.build(files, self.release_bytes)
        manifest = json.loads(assets[BUILD.MANIFEST])
        verified = BOOT.verify_files(assets[BUILD.ARCHIVE], manifest)
        with tempfile.TemporaryDirectory() as folder:
            for name, data in verified.items():
                destination = Path(folder) / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(data)
            entry = Path(folder) / "scripts/orbis-install.py"
            spec = importlib.util.spec_from_file_location("packaged_guided_installer", entry)
            guided = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(guided)
            for name in ("install-orbis.py", "orbis-install-new.py", "orbis-host-service-enable.py"):
                with self.subTest(name=name):
                    module = guided.load(name, "packaged_" + name)
                    self.assertEqual(Path(module.__file__).parent, entry.parent)

    def test_rejects_altered_manifest_and_wrong_release_identity(self):
        with self.assertRaisesRegex(ValueError, "match this release"):
            BOOT.verify_manifest(self.assets[BUILD.MANIFEST] + b" ", self.identity)
        for key in ["tag", "commit", "schema", "archive"]:
            value = copy.deepcopy(self.manifest)
            value[key] = "different"
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.validate_manifest_value(value)

    def test_rejects_unsafe_file_lists_and_excess_sizes(self):
        for name in ["../outside.py", "/scripts/orbis-install.py", "scripts/../orbis-install.py", "scripts/AGENTS.md", "scripts/orbis-install.py/extra"]:
            value = copy.deepcopy(self.manifest)
            value["files"][name] = {"size": 1, "sha256": "0" * 64}
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.validate_manifest_value(value)
        for size in [True, -1, 1024 * 1024 + 1, "10"]:
            value = copy.deepcopy(self.manifest)
            value["files"]["scripts/orbis-install.py"]["size"] = size
            with self.subTest(size=size), self.assertRaises(ValueError):
                self.validate_manifest_value(value)

    def test_rejects_corrupt_archives_and_incorrect_per_file_hashes(self):
        with self.assertRaisesRegex(ValueError, "archive does not match"):
            BOOT.verify_files(self.assets[BUILD.ARCHIVE] + b"x", self.manifest)
        value = copy.deepcopy(self.manifest)
        value["files"]["scripts/orbis-install.py"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "file hash"):
            BOOT.verify_files(self.assets[BUILD.ARCHIVE], value)

    def test_rejects_symlinks_hardlinks_directories_and_path_traversal_before_extraction(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.DIRTYPE]:
            entry = tarfile.TarInfo("scripts/orbis-install.py")
            entry.type = kind
            entry.linkname = "/etc/owned-test-target"
            data, manifest = self.tar([(entry, None)])
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "unsafe entry"):
                BOOT.verify_files(data, manifest)
        entry = tarfile.TarInfo("../outside.py")
        data, manifest = self.tar([(entry, b"")])
        with self.assertRaisesRegex(ValueError, "unsafe entry"):
            BOOT.verify_files(data, manifest)

    def test_rejects_duplicate_missing_and_size_changed_entries(self):
        name = "scripts/orbis-install.py"
        data = self.files[name]
        entry = tarfile.TarInfo(name)
        entry.size = len(data)
        archive, manifest = self.tar([(entry, data), (entry, data)])
        with self.assertRaisesRegex(ValueError, "unsafe entry"):
            BOOT.verify_files(archive, manifest)
        archive, manifest = self.tar([(entry, data)])
        with self.assertRaisesRegex(ValueError, "missing required"):
            BOOT.verify_files(archive, manifest)
        entry.size = 1
        archive, manifest = self.tar([(entry, b"x")])
        with self.assertRaisesRegex(ValueError, "file size"):
            BOOT.verify_files(archive, manifest)

    def test_builder_requires_real_installer_sources_and_valid_image_identity(self):
        files = {name: data for name, data in self.files.items() if name != "scripts/orbis-install.py"}
        with self.assertRaises(ValueError):
            BUILD.build(files, self.release_bytes)
        for key in ["commit", "tag", "image", "digest", "installationProtocol"]:
            release = {**self.release, key: "bad"}
            with self.subTest(key=key), self.assertRaises(ValueError):
                BUILD.build(self.files, json.dumps(release).encode())

    def test_git_symlink_and_uncommitted_inputs_cannot_enter_release_bundle(self):
        with mock.patch.object(BUILD.subprocess, "check_output", return_value=b"120000 blob " + b"a" * 40 + b"\tscripts/orbis-install.py\0"):
            with self.assertRaisesRegex(ValueError, "committed regular"):
                BUILD.committed_files(Path.cwd(), "a" * 40)
        with self.assertRaisesRegex(ValueError, "full release commit"):
            BUILD.committed_files(Path.cwd(), "main")

    def test_downloader_refuses_https_downgrades_and_oversize_responses(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.geturl.return_value = "http://example.invalid/installer"
        with mock.patch.object(BOOT, "urlopen", return_value=response), self.assertRaisesRegex(ValueError, "HTTPS"):
            BOOT.fetch("https://github.com/owned-test", 10)
        response.geturl.return_value = "https://release-assets.githubusercontent.com/owned-test"
        response.read.return_value = b"x" * 11
        with mock.patch.object(BOOT, "urlopen", return_value=response), self.assertRaisesRegex(ValueError, "size limit"):
            BOOT.fetch("https://github.com/owned-test", 10)

    def test_downloaded_bytes_are_not_executed_when_the_manifest_identity_is_wrong(self):
        identity = {**self.identity, "manifestSha256": "0" * 64}
        with mock.patch.object(BOOT, "EXPECTED_RELEASE", identity), mock.patch.object(BOOT.sys, "platform", "linux"), mock.patch.object(BOOT.os, "geteuid", return_value=0), mock.patch.object(BOOT.sys, "argv", ["install-orbis.py"]), mock.patch.object(BOOT, "fetch", return_value=self.assets[BUILD.MANIFEST]), mock.patch.object(BOOT, "private_directory") as create, mock.patch.object(BOOT.os, "execv") as execute:
            with self.assertRaises(ValueError):
                BOOT.main()
            create.assert_not_called()
            execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
