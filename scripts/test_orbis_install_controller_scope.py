import copy
import importlib.util
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

SPEC = importlib.util.spec_from_file_location("controller_scope_fixtures", Path(__file__).with_name("test_orbis_install_transaction.py"))
FIXTURES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FIXTURES)
TX = FIXTURES.TX
STORAGE = TX.STORAGE
SNAPSHOT = STORAGE.SNAPSHOT


class ControllerScopeTests(unittest.TestCase):
    setUp = FIXTURES.TransactionTests.setUp
    states = FIXTURES.TransactionTests.states

    def review(self):
        return TX.review(self.root, self.docker, self.bundle, self.journal, scope="controller")

    def test_review_excludes_app_data_and_never_changes_apps(self):
        value = self.review()
        self.assertEqual(set(value["roles"].values()), {"controller", "database", "queue", "proxy"})
        storage = value["storage"]
        self.assertEqual(storage["preservedAppContainers"], sorted(self.docker.apps))
        self.assertEqual(storage["resources"][0]["excludedPaths"], ["app-data"])
        self.assertEqual(storage["conflictingWriters"], [])
        self.assertEqual(self.docker.calls, [])
        before = copy.deepcopy(self.docker.apps)
        TX.quiesce(self.root, self.docker, {"review": value, "stage": "quiescing"})
        self.assertEqual(self.docker.apps, before)
        self.assertTrue(all(args[-1] not in before for args, _ in self.docker.calls))

    def test_writable_parent_or_metadata_mount_still_blocks(self):
        app = next(iter(self.docker.apps.values()))
        for source in (self.root, self.root / "apps", self.root / ".env"):
            with self.subTest(source=source):
                app["mounts"].append({"Type": "bind", "Source": str(source), "Destination": "/extra", "RW": True})
                with self.assertRaisesRegex(TX.TransactionError, "Another container"):
                    self.review()
                app["mounts"].pop()
        self.assertEqual(self.docker.calls, [])

    def test_metadata_inside_live_app_data_is_not_silently_excluded(self):
        database = self.docker.services[FIXTURES.identifier("runtipi-db")]
        database["mounts"] = [{"Type": "bind", "Source": str(self.root / "app-data/app-0"), "Destination": "/database", "RW": True}]
        with self.assertRaisesRegex(STORAGE.StorageError, "share a storage root"):
            self.review()
        self.assertEqual(self.docker.calls, [])

    def test_hardlink_from_metadata_to_excluded_data_blocks_before_copy(self):
        data = self.root / "app-data/app-0/live"
        data.write_text("live app data")
        os.link(data, self.root / "metadata-link")
        with self.assertRaisesRegex(STORAGE.StorageError, "hard link crosses"):
            STORAGE.require_contained_hardlinks(self.review()["storage"]["resources"])
        self.assertEqual(self.docker.calls, [])

    def test_scope_and_exclusions_are_bound_to_review(self):
        value = self.review()["storage"]
        edited = copy.deepcopy(value)
        edited["resources"][0]["excludedPaths"].append("apps")
        with self.assertRaisesRegex(STORAGE.StorageError, "edited"):
            STORAGE.validate_review(edited)
        full = TX.review(self.root, self.docker, self.bundle, self.journal)["storage"]
        self.assertNotIn("backupScope", full)
        self.assertNotIn("excludedPaths", full["resources"][0])
        STORAGE.validate_review(full)

    def test_exclusion_paths_reject_aliases_and_escape_rsync_patterns(self):
        for value in ("../apps", "/apps", "a//b", "a/./b", "a/../b", "apps/", "a\nb"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                SNAPSHOT.excluded_paths([value])
        self.assertEqual(SNAPSHOT.rsync_excludes(["data[*]?"]), [r"--exclude=/data\[\*]\?"])

    @unittest.skipUnless(sys.platform == "linux", "requires Linux rsync with ACL/xattr support")
    def test_checkpoint_and_recovery_preserve_newer_live_app_writes(self):
        before_apps = copy.deepcopy(self.docker.apps)
        data = self.root / "app-data/app-0/live"
        data.write_bytes(b"before checkpoint")
        os.mkfifo(self.root / "app-data/app-0/live-pipe")
        cache = self.root / "cache"
        cache.mkdir()
        (cache / "session").write_bytes(b"original session")
        original_env = (self.root / ".env").read_bytes()
        value = self.review()
        real_run = SNAPSHOT.subprocess.run

        def copy_while_app_writes(arguments, *args, **kwargs):
            if arguments[0] == "rsync":
                data.write_bytes(b"written during backup")
            return real_run(arguments, *args, **kwargs)

        with mock.patch.object(SNAPSHOT.subprocess, "run", side_effect=copy_while_app_writes):
            TX.checkpoint(self.root, self.docker, value, host_writers_stopped=True)
        saved = STORAGE.verified_manifest(self.bundle)
        self.assertFalse((self.bundle / "resource-0000/app-data").exists())
        self.assertEqual(saved["copies"][0]["record"]["excludedPaths"], ["app-data"])
        data.write_bytes(b"newer live application data")
        inode_replacement = self.root / ".env-new"
        inode_replacement.write_bytes(b"rotated fresh authentication secret")
        os.replace(inode_replacement, self.root / ".env")
        (cache / "session").unlink()
        (self.root / "orbis-compose.yml").write_bytes(b"staged override")
        TX.recover(self.root, self.docker, self.journal, host_writers_stopped=True)
        self.assertEqual((self.root / ".env").read_bytes(), original_env)
        self.assertEqual((cache / "session").read_bytes(), b"original session")
        self.assertFalse((self.root / "orbis-compose.yml").exists())
        self.assertEqual(data.read_bytes(), b"newer live application data")
        self.assertEqual(self.docker.apps, before_apps)
        self.assertTrue(all(args[-1] not in before_apps for args, _ in self.docker.calls))

    @unittest.skipUnless(sys.platform == "linux", "requires Linux rsync with ACL/xattr support")
    def test_filtered_snapshot_seals_whole_saved_tree_and_literal_names(self):
        literal = self.root / "data[*]?"
        literal.mkdir()
        (literal / "live").write_text("excluded")
        other = self.root / "dataX"
        other.mkdir()
        (other / "config").write_text("included")
        SNAPSHOT.capture(self.root, self.bundle, "test", "default", excluded=["data[*]?"])
        self.assertFalse((self.bundle / "data[*]?").exists())
        self.assertEqual((self.bundle / "dataX/config").read_text(), "included")
        SNAPSHOT.verify(self.bundle)
        (self.bundle / "data[*]?").mkdir()
        (self.bundle / "data[*]?/injected").write_text("not sealed")
        with self.assertRaisesRegex(ValueError, "no longer matches"):
            SNAPSHOT.verify(self.bundle)


if __name__ == "__main__":
    unittest.main()
