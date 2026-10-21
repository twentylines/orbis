import copy
import importlib.util
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_install_storage", Path(__file__).with_name("orbis-install-storage.py"))
assert SPEC and SPEC.loader
STORAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STORAGE)
FIXTURES = STORAGE.APPS.load_script("test_orbis_install_apps.py", "apps_storage_fixtures")


class Docker(FIXTURES.Docker):
    def __init__(self, root):
        super().__init__(root)
        self.volumes = {}
        self.controller_policy = {"Name": "no", "MaximumRetryCount": 0}

    def core(self, container):
        result = super().core(container)
        for mount in result["mounts"]:
            mount["RW"] = True
        return result

    def app(self, container):
        if container != self.controller_id:
            return super().app(container)
        return {
            "id": container, "name": "/runtipi", "imageId": self.controller_image_id,
            "image": self.controller_image, "labels": {"com.docker.compose.project": "runtipi"},
            "mounts": self.core(container)["mounts"], "state": self.controller_state,
            "autoRemove": False, "stopTimeout": 30, "restartPolicy": self.controller_policy,
        }

    def _object(self, arguments):
        if arguments[:2] == ["volume", "inspect"]:
            return copy.deepcopy(self.volumes[arguments[-1]])
        return super()._object(arguments)


class InstallationStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name).resolve()
        self.root = self.parent / "install"
        self.root.mkdir(mode=0o700)
        for name in [".env", "docker-compose.yml"]:
            (self.root / name).write_text("private fixture data\n")
        (self.root / "apps").mkdir()
        self.private = self.parent / "private"
        self.private.mkdir(mode=0o700)
        self.bundle = self.private / "backup"
        self.docker = Docker(self.root)
        for app in self.docker.apps.values():
            data = Path(app["mounts"][0]["Source"])
            data.mkdir(parents=True)
            (data / "data.bin").write_bytes(b"\x00orbis\xff\n")
        self.external = self.parent / "external"
        self.external.mkdir(mode=0o750)
        (self.external / "database.bin").write_bytes(b"external database\x00\xff")
        os.chmod(self.external / "database.bin", 0o640)
        self.file = self.parent / "app-config"
        self.file.write_bytes(b"private file mount\n")
        os.chmod(self.file, 0o600)
        self.volume = self.parent / "volume-data"
        self.volume.mkdir()
        (self.volume / "cache.bin").write_bytes(b"named-volume\x00\xff")
        self.docker.volumes["app-cache"] = {"name": "app-cache", "driver": "local", "mountpoint": str(self.volume)}
        self.docker.apps[FIXTURES.identifier("app-0")]["mounts"].extend([
            {"Type": "bind", "Source": str(self.external), "Destination": "/database", "RW": True},
            {"Type": "bind", "Source": str(self.file), "Destination": "/config", "RW": False},
            {"Type": "volume", "Name": "app-cache", "Source": str(self.volume), "Destination": "/cache", "RW": True},
        ])

    def quiet(self):
        self.docker.controller_state = "exited"
        for app in self.docker.apps.values():
            if app["state"] == "running":
                app["state"] = "exited"
            app["restartPolicy"] = {"Name": "no", "MaximumRetryCount": 0}

    def review(self):
        return STORAGE.review(self.root, self.docker, self.bundle)

    def capture(self):
        reviewed = self.review()
        self.quiet()
        return STORAGE.capture(self.root, self.docker, reviewed, host_writers_stopped=True)

    def foreign(self, *, readonly=False, stopped=False):
        self.docker.add_app(99, "exited" if stopped else "running")
        app = self.docker.apps[FIXTURES.identifier("app-99")]
        app["labels"]["runtipi.managed"] = "false"
        app["labels"]["com.docker.compose.project.working_dir"] = "/another/install"
        app["mounts"] = [{"Type": "bind", "Source": str(self.external), "Destination": "/shared", "RW": not readonly}]
        if stopped:
            app["restartPolicy"] = {"Name": "no", "MaximumRetryCount": 0}
        return app

    def test_review_covers_root_external_directory_file_and_local_volume_without_writes(self):
        reviewed = self.review()
        self.assertEqual({item["source"] for item in reviewed["resources"]}, {str(self.root), str(self.external), str(self.file), str(self.volume)})
        self.assertEqual(len(reviewed["containers"]), 4)
        self.assertGreater(reviewed["estimatedBytes"], 0)
        self.assertTrue(reviewed["hostWriterReviewRequired"])
        self.assertEqual(self.docker.calls, [])
        self.assertFalse(self.bundle.exists())
        self.assertNotIn("private fixture data", json.dumps(reviewed))

    def test_capture_and_offline_verification_preserve_binary_data_and_file_metadata(self):
        result = self.capture()
        self.assertEqual(result["result"], "storage-backup-verified")
        self.assertEqual(result["resources"], 4)
        self.assertEqual(STORAGE.verify(self.bundle), result)
        self.assertEqual(stat.S_IMODE(self.bundle.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((self.bundle / "storage.json").stat().st_mode), 0o600)
        manifest = json.loads((self.bundle / "storage.json").read_text())
        for index, resource in enumerate(manifest["plan"]["resources"]):
            if resource["kind"] == "file":
                self.assertEqual(STORAGE.file_fingerprint(self.bundle / f"resource-{index:04d}"), STORAGE.file_fingerprint(self.file))
        self.assertEqual(self.docker.calls, [])

    def test_running_controller_app_or_restart_policy_prevents_any_copy(self):
        for state in ["controller", "app", "policy"]:
            with self.subTest(state=state):
                self.quiet()
                reviewed = self.review()
                if state == "controller": self.docker.controller_state = "running"
                if state == "app": self.docker.apps[FIXTURES.identifier("app-0")]["state"] = "running"
                if state == "policy": self.docker.controller_policy = {"Name": "always", "MaximumRetryCount": 0}
                with self.assertRaisesRegex(STORAGE.StorageError, "Stop every"):
                    STORAGE.capture(self.root, self.docker, reviewed, host_writers_stopped=True)
                self.assertFalse(self.bundle.exists())
                self.docker.controller_policy = {"Name": "no", "MaximumRetryCount": 0}

    def test_native_writer_confirmation_is_required(self):
        self.quiet()
        with self.assertRaisesRegex(STORAGE.StorageError, "native host"):
            STORAGE.capture(self.root, self.docker, self.review(), host_writers_stopped=False)
        self.assertFalse(self.bundle.exists())

    def test_foreign_writable_mount_blocks_but_readonly_or_quiet_container_does_not(self):
        app = self.foreign()
        self.assertEqual(len(self.review()["conflictingWriters"]), 1)
        self.quiet()
        app["state"] = "running"
        reviewed = self.review()
        with self.assertRaisesRegex(STORAGE.StorageError, "Another container"):
            STORAGE.capture(self.root, self.docker, reviewed, host_writers_stopped=True)
        app["mounts"][0]["RW"] = False
        self.assertEqual(self.review()["conflictingWriters"], [])
        app["mounts"][0]["RW"] = True
        app["state"] = "exited"
        self.assertEqual(self.review()["conflictingWriters"], [])

    def test_new_writer_or_restart_during_copy_leaves_bundle_incomplete(self):
        for change in ["new-writer", "restart"]:
            with self.subTest(change=change):
                self.bundle = self.private / change
                self.quiet()
                reviewed = self.review()
                original = STORAGE.SNAPSHOT.capture
                def changed(*args):
                    result = original(*args)
                    if change == "new-writer": self.foreign()
                    else: self.docker.controller_state = "running"
                    return result
                with mock.patch.object(STORAGE.SNAPSHOT, "capture", side_effect=changed):
                    with self.assertRaises(STORAGE.StorageError):
                        STORAGE.capture(self.root, self.docker, reviewed, host_writers_stopped=True)
                with self.assertRaisesRegex(STORAGE.StorageError, "incomplete"):
                    STORAGE.verify(self.bundle)
                self.docker.apps.pop(FIXTURES.identifier("app-99"), None)

    def test_replaced_source_or_changed_daemon_or_definition_rejects_stale_review(self):
        for change in ["source", "daemon", "mount"]:
            with self.subTest(change=change):
                self.quiet()
                reviewed = self.review()
                if change == "source":
                    self.file.rename(self.file.with_name("old-config"))
                    self.file.write_text("replacement")
                if change == "daemon": self.docker.daemon_id = "other-daemon"
                if change == "mount": self.docker.apps[FIXTURES.identifier("app-0")]["mounts"][0]["RW"] = False
                with self.assertRaisesRegex(STORAGE.StorageError, "changed since review"):
                    STORAGE.capture(self.root, self.docker, reviewed, host_writers_stopped=True)
                self.assertFalse(self.bundle.exists())
                self.docker.daemon_id = "test-daemon"

    def test_native_changes_to_an_earlier_copy_prevent_completion(self):
        for change in ["file", "directory"]:
            with self.subTest(change=change):
                self.bundle = self.private / ("changed-" + change)
                self.quiet()
                reviewed = self.review()
                original = STORAGE.SNAPSHOT.capture
                def changed(source, *args):
                    result = original(source, *args)
                    if source == self.volume:
                        target = self.file if change == "file" else self.external / "database.bin"
                        target.write_text("native writer changed an earlier copy")
                    return result
                with mock.patch.object(STORAGE.SNAPSHOT, "capture", side_effect=changed):
                    with self.assertRaisesRegex(STORAGE.StorageError, "Storage changed after"):
                        STORAGE.capture(self.root, self.docker, reviewed, host_writers_stopped=True)
                with self.assertRaisesRegex(STORAGE.StorageError, "incomplete"):
                    STORAGE.verify(self.bundle)

    def test_nested_mounts_are_copied_once_and_backup_inside_external_data_is_rejected(self):
        child = self.external / "child"
        child.mkdir()
        self.docker.apps[FIXTURES.identifier("app-0")]["mounts"].append({"Type": "bind", "Source": str(child), "Destination": "/nested", "RW": True})
        self.assertEqual(len(self.review()["resources"]), 4)
        os.chmod(self.external, 0o700)
        with self.assertRaisesRegex(STORAGE.StorageError, "outside every source"):
            STORAGE.review(self.root, self.docker, self.external / "backup")

    def test_volume_identity_symlink_and_system_sources_are_rejected(self):
        self.docker.volumes["app-cache"]["mountpoint"] = str(self.external)
        with self.assertRaisesRegex(STORAGE.StorageError, "local Docker volume"):
            self.review()
        for path in [Path("/"), Path("/etc"), Path("/proc/cpuinfo")]:
            with self.assertRaises(STORAGE.StorageError): STORAGE.source_identity(path)
        alias = self.parent / "alias"
        alias.symlink_to(self.external)
        with self.assertRaisesRegex(STORAGE.StorageError, "symlink"):
            STORAGE.source_identity(alias)

    def test_partial_copy_corruption_missing_resource_and_manifest_edits_are_not_verified(self):
        self.capture()
        target = self.bundle / "storage.json"
        original = target.read_bytes()
        manifest = json.loads(original)
        manifest["copies"].pop()
        target.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(STORAGE.StorageError, "missing resources"): STORAGE.verify(self.bundle)
        target.write_bytes(original)
        manifest = json.loads(original)
        manifest["plan"]["resources"][0]["source"] = "/another/path"
        target.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(STORAGE.StorageError, "invalid or was edited"): STORAGE.verify(self.bundle)
        target.write_bytes(original)
        index = next(index for index, item in enumerate(json.loads(original)["plan"]["resources"]) if item["source"] == str(self.root))
        (self.bundle / f"resource-{index:04d}" / ".env").write_text("corrupted")
        with self.assertRaises(ValueError): STORAGE.verify(self.bundle)

    def test_verification_does_not_require_original_storage_to_still_exist(self):
        result = self.capture()
        self.file.rename(self.file.with_name("removed-config"))
        self.external.rename(self.external.with_name("removed-external"))
        self.assertEqual(STORAGE.verify(self.bundle), result)

    def test_changed_file_timestamp_in_directory_backup_is_rejected(self):
        self.capture()
        manifest = json.loads((self.bundle / "storage.json").read_text())
        index = next(index for index, item in enumerate(manifest["plan"]["resources"]) if item["source"] == str(self.external))
        file = self.bundle / f"resource-{index:04d}" / "database.bin"
        previous = file.stat()
        os.utime(file, ns=(previous.st_atime_ns, previous.st_mtime_ns + 1000000))
        with self.assertRaisesRegex(STORAGE.StorageError, "metadata no longer matches"):
            STORAGE.verify(self.bundle)

    def test_final_recheck_does_not_require_space_for_a_second_backup(self):
        self.quiet()
        reviewed = self.review()
        self.assertEqual(STORAGE.capture(self.root, self.docker, reviewed, host_writers_stopped=True)["resources"], 4)
        with mock.patch.object(STORAGE.SNAPSHOT, "preflight", side_effect=AssertionError("second capacity walk")), mock.patch.object(STORAGE.shutil, "disk_usage", side_effect=AssertionError("second capacity requirement")):
            STORAGE.require_quiet_existing(self.root, self.docker, reviewed)


if __name__ == "__main__":
    unittest.main()
