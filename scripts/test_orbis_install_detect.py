import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_install_detect", Path(__file__).with_name("orbis-install-detect.py"))
assert SPEC and SPEC.loader
DETECT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DETECT)


def container(number=1, *, image="ghcr.io/runtipi/runtipi:v4.10.1", name="runtipi", service="runtipi", root="/srv/runtipi", state="running", project="runtipi", ports=""):
    return {"id": f"{number:064x}", "image": image, "name": name, "project": project, "service": service, "workingDir": root, "state": state, "publishedPorts": ports, "managed": "", "appUrn": ""}


def mounts(root="/srv/runtipi"):
    return [
        {"Type": "bind", "Source": root + "/.env", "Destination": "/data/.env"},
        {"Type": "bind", "Source": root + "/docker-compose.yml", "Destination": "/data/docker-compose.yml"},
        {"Type": "bind", "Source": root + "/app-data", "Destination": "/app-data"},
        {"Type": "bind", "Source": root + "/apps", "Destination": "/data/apps"},
    ]


class Reader:
    context = "test-only"

    def __init__(self, rows, *, mount_list=None, version="4.10.1", ports=None, after=None, daemon_after=None):
        self.rows = rows
        self.after = after
        self.mount_list = mounts() if mount_list is None else mount_list
        self.version = version
        self.bindings = ports or {}
        self.daemon_after = daemon_after
        self.container_reads = 0
        self.daemon_reads = 0
        self.inspected = []

    def daemon(self):
        self.daemon_reads += 1
        return self.daemon_after if self.daemon_after and self.daemon_reads > 1 else "test-daemon"

    def containers(self):
        self.container_reads += 1
        return copy.deepcopy(self.after if self.after is not None and self.container_reads > 1 else self.rows)

    def core(self, identifier):
        self.inspected.append(identifier)
        row = next(row for row in self.rows if row["id"] == identifier)
        return {"id": identifier, "imageId": "sha256:" + "a" * 64, "mounts": mounts(row["workingDir"]) if self.mount_list == "per-root" else copy.deepcopy(self.mount_list)}

    def image(self, identifier):
        return {"version": self.version}

    def ports(self, identifier):
        return {"bindings": self.bindings.get(identifier)}


class InstallationDiscoveryTests(unittest.TestCase):
    def test_existing_stock_has_two_choices_without_authorizing_a_migration(self):
        report = DETECT.discover(Reader([container()]))
        self.assertEqual(report["result"], "runtipi-found")
        installation = report["installations"][0]
        self.assertEqual(installation["installRoot"], "/srv/runtipi")
        self.assertEqual(installation["rootStatus"], "confirmed-by-mounts")
        self.assertEqual(installation["reviewRequired"], [])
        self.assertEqual([item["mode"] for item in installation["choices"]], ["keep", "fresh"])
        self.assertEqual(installation["nameConflicts"], [])
        self.assertTrue(report["readOnly"])
        self.assertFalse(report["executionAllowed"])
        self.assertFalse(report["hostFilesInspected"])

    def test_empty_inventory_and_unrelated_apps_do_not_require_file_scans(self):
        reader = Reader([container(name="photos", service="web", project="photos", image="example/photos:1", root="/other")])
        report = DETECT.discover(reader)
        self.assertEqual(report["result"], "no-controller-found")
        self.assertEqual(reader.inspected, [])

    def test_a_reserved_name_is_a_conflict_not_evidence_of_runtipi(self):
        report = DETECT.discover(Reader([container(image="example/unrelated:1", project="", service="", root="")]))
        self.assertEqual(report["result"], "conflicts-found")
        self.assertEqual(report["installations"], [])

    def test_an_unknown_controller_image_is_never_reported_as_a_new_install(self):
        report = DETECT.discover(Reader([container(image="ghcr.io/untrusted/runtipi:4.10.1")]))
        self.assertEqual(report["result"], "installation-requires-review")
        self.assertIn("unrecognized-controller-image", report["installations"][0]["reviewRequired"])
        self.assertEqual(report["installations"][0]["choices"], [])

    def test_orbis_digest_is_recognized_without_offering_runtipi_replacement(self):
        report = DETECT.discover(Reader([container(image="ghcr.io/twentylines/orbis@sha256:" + "b" * 64)], version="v0.1.0-beta.62"))
        self.assertEqual(report["result"], "orbis-found")
        self.assertEqual(report["installations"][0]["version"], "0.1.0-beta.62")
        self.assertEqual(report["installations"][0]["choices"], [])

    def test_a_control_plane_image_used_by_an_app_is_not_a_controller(self):
        reader = Reader([container(service="test-image", project="sandbox", name="test-image")])
        self.assertEqual(DETECT.discover(reader)["installations"], [])
        self.assertEqual(reader.inspected, [])

    def test_versions_outside_the_compatibility_base_require_review(self):
        report = DETECT.discover(Reader([container(image="ghcr.io/runtipi/runtipi:v5.0.0")], version="5.0.0"))
        self.assertIn("runtipi-version-requires-review", report["installations"][0]["reviewRequired"])

    def test_stopped_stock_and_missing_image_version_label_use_the_image_tag(self):
        report = DETECT.discover(Reader([container(state="exited")], version=None))
        self.assertEqual(report["installations"][0]["version"], "4.10.1")
        self.assertEqual(report["installations"][0]["container"]["state"], "exited")

    def test_missing_root_anchors_never_mark_the_working_directory_confirmed(self):
        report = DETECT.discover(Reader([container()], mount_list=[]))
        installation = report["installations"][0]
        self.assertIn("installation-root-unverified", installation["reviewRequired"])
        self.assertEqual(installation["rootStatus"], "requires-path-verification")

    def test_disagreeing_labels_or_root_files_fail_closed(self):
        for mount_list in [mounts("/somewhere-else"), [mounts()[0], mounts("/somewhere-else")[1]]]:
            with self.subTest(mounts=mount_list):
                installation = DETECT.discover(Reader([container()], mount_list=mount_list))["installations"][0]
                self.assertIsNone(installation["installRoot"])
                self.assertEqual(installation["rootStatus"], "conflicting-paths")

    def test_external_storage_named_volumes_and_volatile_data_are_visible(self):
        data = mounts() + [
            {"Type": "bind", "Source": "/srv/runtipi-other/media", "Destination": "/data/media"},
            {"Type": "volume", "Name": "app-state", "Source": "/docker/internal/path", "Destination": "/data/state"},
            {"Type": "tmpfs", "Destination": "/data/backups"},
            {"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/var/run/docker.sock"},
        ]
        storage = {item["destination"]: item for item in DETECT.discover(Reader([container()], mount_list=data))["installations"][0]["storage"]}
        self.assertFalse(storage["/app-data"]["external"])
        self.assertTrue(storage["/data/media"]["external"])
        self.assertEqual(storage["/data/state"]["volume"], "app-state")
        self.assertTrue(storage["/data/state"]["external"])
        self.assertTrue(storage["/data/backups"]["volatile"])
        self.assertNotIn("/var/run/docker.sock", storage)
        self.assertNotIn("/docker/internal/path", json.dumps(storage))

    def test_multiple_installations_require_selection_and_do_not_own_each_other(self):
        rows = [container(), container(2, name="old-runtipi", root="/srv/old")]
        report = DETECT.discover(Reader(rows, mount_list="per-root"))
        self.assertEqual(report["result"], "select-installation")
        old = next(item for item in report["installations"] if item["installRoot"] == "/srv/old")
        self.assertEqual(old["nameConflicts"][0]["container"], "runtipi")
        self.assertEqual(len({item["id"] for item in report["installations"]}), 2)

    def test_unrelated_paused_proxy_ports_are_reported_and_ipv6_is_deduplicated(self):
        proxy = container(2, name="proxy", image="example/proxy:1", project="other", service="web", root="/other", state="paused", ports="0.0.0.0:80->80/tcp, [::]:80->80/tcp")
        bindings = {proxy["id"]: {"80/tcp": [{"HostPort": "80", "HostIp": "0.0.0.0"}, {"HostPort": "80", "HostIp": "::"}], "443/tcp": None}}
        report = DETECT.discover(Reader([container(), proxy], ports=bindings))
        self.assertEqual(len(report["installations"][0]["freshPortConflicts"]), 1)
        self.assertEqual(report["installations"][0]["freshPortConflicts"][0]["port"], 80)

    def test_the_target_proxy_is_not_a_takeover_conflict(self):
        proxy = container(2, name="runtipi-reverse-proxy", image="traefik:v3", service="runtipi-reverse-proxy", ports="80->80/tcp")
        report = DETECT.discover(Reader([container(), proxy], ports={proxy["id"]: {"80/tcp": [{"HostPort": "80"}]}}))
        self.assertEqual(report["installations"][0]["freshPortConflicts"], [])
        self.assertEqual(report["installations"][0]["nameConflicts"], [])
        self.assertEqual(report["newInstallationConflicts"]["ports"][0]["port"], 80)

    def test_daemon_or_container_changes_invalidate_the_entire_scan(self):
        for reader in [Reader([], after=[container()]), Reader([container()], daemon_after="different-daemon")]:
            with self.subTest(reader=reader):
                with self.assertRaisesRegex(DETECT.InspectionError, "changed during discovery"):
                    DETECT.discover(reader)

    def test_duplicate_or_malformed_metadata_is_an_inspection_failure(self):
        malformed = container()
        malformed["workingDir"] = "/srv/install\nsecret"
        for rows in [[container(), container()], [malformed], [{"id": "not-a-docker-id"}]]:
            with self.subTest(rows=rows):
                with self.assertRaises(DETECT.InspectionError):
                    DETECT.discover(Reader(rows))

    def test_duplicate_mounts_do_not_appear_as_a_confirmed_installation(self):
        with self.assertRaisesRegex(DETECT.InspectionError, "duplicate mount"):
            DETECT.discover(Reader([container()], mount_list=mounts() + [mounts()[0]]))

    def test_no_environment_labels_or_unrelated_mounts_are_exposed(self):
        reader = Reader([container()])
        original = reader.core

        def core(identifier):
            value = original(identifier)
            value.update({"Env": ["SECRET=private"], "labels": {"token": "private"}})
            return value

        reader.core = core
        output = json.dumps(DETECT.discover(reader))
        self.assertNotIn("SECRET", output)
        self.assertNotIn("private", output)
        self.assertNotIn("labels", output)

    def test_docker_invocations_are_explicit_read_only_and_suppress_raw_errors(self):
        calls = []

        def run(arguments, **options):
            calls.append(arguments)
            self.assertEqual(arguments[:3], ["docker", "--context", "chosen-host"])
            self.assertEqual(options["stderr"], subprocess.DEVNULL)
            self.assertNotIn("shell", options)
            if arguments[3] == "info":
                return subprocess.CompletedProcess(arguments, 0, "test-daemon\n")
            if arguments[3:5] == ["container", "ls"]:
                return subprocess.CompletedProcess(arguments, 0, "")
            raise AssertionError(arguments)

        with mock.patch.object(DETECT.subprocess, "run", side_effect=run):
            report = DETECT.discover(DETECT.DockerReader("chosen-host"))
        self.assertEqual(report["result"], "no-controller-found")
        self.assertEqual(len(calls), 4)
        with mock.patch.object(DETECT.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "SECRET=private")):
            with self.assertRaisesRegex(DETECT.InspectionError, "check the selected context") as raised:
                DETECT.DockerReader("chosen-host").daemon()
        self.assertNotIn("private", str(raised.exception))

    def test_docker_timeout_or_missing_permission_is_not_no_installation(self):
        for error in [PermissionError("private path"), subprocess.TimeoutExpired("private args", 20)]:
            with mock.patch.object(DETECT.subprocess, "run", side_effect=error):
                with self.assertRaises(DETECT.InspectionError) as raised:
                    DETECT.discover(DETECT.DockerReader("chosen-host"))
                self.assertNotIn("private", str(raised.exception))
        for context in ["", "--host=elsewhere", "chosen\nhost"]:
            with self.assertRaises(ValueError):
                DETECT.DockerReader(context)

    def test_managed_app_mounts_include_overrides_external_media_and_named_volumes(self):
        app = container(2, name="notes", image="example/notes:1", project="notes_local", service="notes", root="/srv/runtipi/apps/local/notes")
        app.update(managed="true", appUrn="notes:local")
        reader = Reader([container(), app])
        original = reader.core

        def core(identifier):
            value = original(identifier)
            if identifier == app["id"]:
                value["mounts"] = [
                    {"Type": "bind", "Source": "/srv/runtipi/user-config/local/notes", "Destination": "/config", "RW": True},
                    {"Type": "bind", "Source": "/mnt/media", "Destination": "/media", "RW": False},
                    {"Type": "volume", "Name": "notes-data", "Destination": "/data", "RW": True},
                ]
            return value

        reader.core = core
        report = DETECT.discover(reader)
        installed = report["installations"][0]["apps"]
        self.assertEqual(len(installed), 1)
        self.assertEqual(installed[0]["appUrn"], "notes:local")
        storage = {item["destination"]: item for item in installed[0]["storage"]}
        self.assertFalse(storage["/config"]["external"])
        self.assertTrue(storage["/media"]["external"])
        self.assertTrue(storage["/media"]["readOnly"])
        self.assertEqual(storage["/data"]["volume"], "notes-data")
        self.assertEqual(report["unassignedManagedContainers"], [])

    def test_managed_app_with_no_controller_requires_review_instead_of_new_setup(self):
        app = container(2, name="notes", image="example/notes:1", project="notes_local", service="notes", root="/removed/apps/local/notes")
        app.update(managed="true", appUrn="notes:local")
        reader = Reader([app])
        report = DETECT.discover(reader)
        self.assertEqual(report["result"], "installation-requires-review")
        self.assertEqual(len(report["unassignedManagedContainers"]), 1)
        self.assertEqual(reader.inspected, [])

    def test_controller_local_compose_directory_maps_through_its_apps_bind(self):
        app = container(2, name="notes", image="example/notes:1", project="notes_local", service="web", root="/data/apps/local/notes")
        app.update(managed="true", appUrn="notes:local")
        report = DETECT.discover(Reader([container(), app]))
        self.assertEqual(report["installations"][0]["apps"][0]["container"]["id"], app["id"])
        self.assertEqual(report["unassignedManagedContainers"], [])
        self.assertFalse(report["hostFilesInspected"])

    def test_shared_controller_alias_or_mismatched_urn_does_not_guess_ownership(self):
        app = container(3, name="notes", image="example/notes:1", project="notes_local", service="web", root="/data/apps/local/notes")
        app.update(managed="true", appUrn="notes:local")
        reader = Reader([container(), container(2, name="other-core", root="/srv/other"), app], mount_list="per-root")
        report = DETECT.discover(reader)
        self.assertEqual(len(report["unassignedManagedContainers"]), 1)
        self.assertTrue(all(not item["apps"] for item in report["installations"]))
        app["appUrn"] = "different:local"
        self.assertEqual(len(DETECT.discover(Reader([container(), app]))["unassignedManagedContainers"]), 1)

    def test_another_installations_app_is_not_assigned_to_the_selected_root(self):
        app = container(2, name="notes", image="example/notes:1", project="notes_local", service="notes", root="/srv/another/apps/local/notes")
        app.update(managed="true", appUrn="notes:local")
        reader = Reader([container(), app])
        report = DETECT.discover(reader)
        self.assertEqual(report["installations"][0]["apps"], [])
        self.assertEqual(len(report["unassignedManagedContainers"]), 1)
        self.assertNotIn(app["id"], reader.inspected)

    def test_ambiguous_nested_app_directories_require_review(self):
        nested = container(2, name="nested", root="/srv/runtipi/apps/nested")
        app = container(3, name="notes", image="example/notes:1", project="notes_local", service="notes", root=nested["workingDir"] + "/apps/local/notes")
        app.update(managed="true", appUrn="notes:local")
        report = DETECT.discover(Reader([container(), nested, app], mount_list="per-root"))
        self.assertEqual(len(report["unassignedManagedContainers"]), 1)
        self.assertTrue(all(not item["apps"] for item in report["installations"]))

    def test_conflicting_controller_paths_do_not_claim_app_ownership(self):
        app = container(2, name="notes", image="example/notes:1", project="notes_local", service="notes", root="/different/apps/local/notes")
        app.update(managed="true", appUrn="notes:local")
        reader = Reader([container(), app], mount_list=mounts("/different"))
        report = DETECT.discover(reader)
        self.assertEqual(report["installations"][0]["rootStatus"], "conflicting-paths")
        self.assertEqual(report["installations"][0]["apps"], [])
        self.assertEqual(len(report["unassignedManagedContainers"]), 1)
        self.assertNotIn(app["id"], reader.inspected)


if __name__ == "__main__":
    unittest.main()
