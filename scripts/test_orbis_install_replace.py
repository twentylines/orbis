import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location("install_replace", Path(__file__).with_name("orbis-install-replace.py"))
assert SPEC and SPEC.loader
REPLACE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPLACE)

OLD = "1" * 64
NEW = "2" * 64
OLD_IMAGE = "sha256:" + "a" * 64
NEW_IMAGE = "sha256:" + "b" * 64
TARGET = {"schema": "orbis.release.v1", "image": "ghcr.io/twentylines/orbis", "digest": "sha256:" + "d" * 64, "tag": "v0.1.0-beta.64", "commit": "c" * 40, "runtipiCompatibility": "4.10.1", "installationProtocol": "orbis.installation-state.v1"}


class Reader:
    def __init__(self):
        self.rows = []
        self.prior = {"Env": ["PATH=/old"], "Cmd": ["old-main"], "Entrypoint": ["old-entry"], "WorkingDir": "/app", "User": "", "Labels": {"org.opencontainers.image.version": "4.10.1"}}
        self.incoming = {"Env": ["PATH=/new", "NEW_DEFAULT=present"], "Cmd": ["new-main"], "Entrypoint": ["new-entry"], "WorkingDir": "/app", "User": "", "Labels": {"org.opencontainers.image.version": "v0.1.0-beta.64"}}

    def _object(self, args):
        if args[:2] == ["network", "inspect"]:
            return {"id": "network-id"}
        return copy.deepcopy(self.prior if args[-1] == OLD_IMAGE else self.incoming)

    def containers(self):
        return copy.deepcopy(self.rows)


class ReplacementTests(unittest.TestCase):
    def setUp(self):
        self.reader = Reader()
        self.raw = {
            "Id": OLD, "Image": OLD_IMAGE, "Name": "/orbis-previous-transaction", "State": {"Status": "exited"},
            "Config": {"Image": "ghcr.io/runtipi/runtipi:v4.10.1", "Hostname": "original-hostname", "Env": ["PATH=/old", "PRIVATE_SETTING=private-fixture-value", "ORBIS_INSTALLER_PHASE=hold"], "Cmd": ["old-main"], "Entrypoint": ["old-entry"], "WorkingDir": "/app", "User": "", "Labels": {"org.opencontainers.image.version": "4.10.1", "com.docker.compose.project": "runtipi", "user-label": "retained"}},
            "HostConfig": {"RestartPolicy": dict(REPLACE.TX.NO_RESTART), "PortBindings": {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3000"}]}, "PublishAllPorts": False, "Memory": 335544320, "ReadonlyRootfs": True, "Binds": ["/srv/install/state:/data/state:rw"], "ExtraHosts": ["internal:192.0.2.2"]},
            "NetworkSettings": {"Networks": {"runtipi-network": {"NetworkID": "network-id", "IPAMConfig": {"IPv4Address": "172.29.64.4"}, "Aliases": ["runtipi"], "DriverOpts": {"option": "retained"}}}},
        }
        self.record = {
            "schema": REPLACE.SCHEMA, "id": "00000000-0000-4000-8000-000000000001", "retainedName": "orbis-previous-transaction", "stage": "holding",
            "review": {"target": TARGET, "controllerName": "runtipi", "image": {"imageId": NEW_IMAGE}, "checkpoint": {"roles": {OLD: "controller"}, "storage": {"containerStates": [{"id": OLD, "restartPolicy": {"Name": "unless-stopped", "MaximumRetryCount": 0}}]}}},
        }
        self.record["quiescedConfiguration"] = REPLACE.APPS.digest({key: self.raw[key] for key in ("Config", "HostConfig")})
        patcher = mock.patch.object(REPLACE, "inspect", side_effect=lambda _, key: copy.deepcopy(self.raw if key == OLD else self.created))
        patcher.start()
        self.addCleanup(patcher.stop)

    def create(self, phase):
        self.record["candidatePhase"] = phase
        body = REPLACE.payload(self.record, self.reader, phase)
        self.created = {"Id": NEW, "Image": NEW_IMAGE, "Name": "/runtipi", "State": {"Status": "created"}, "Config": {k: v for k, v in body.items() if k not in {"HostConfig", "NetworkingConfig"}}, "HostConfig": copy.deepcopy(body["HostConfig"]), "NetworkSettings": copy.deepcopy(self.raw["NetworkSettings"])}
        self.reader.rows = [{"id": NEW, "name": "runtipi"}, {"id": OLD, "name": self.record["retainedName"]}]
        return body

    def test_hold_and_resume_preserve_host_settings_but_publish_no_ports(self):
        before = copy.deepcopy(self.raw)
        for phase in ["hold", "resume"]:
            with self.subTest(phase=phase):
                body = self.create(phase)
                self.assertEqual(body["HostConfig"]["PortBindings"], {})
                for key in ["Memory", "ReadonlyRootfs", "Binds", "ExtraHosts"]:
                    self.assertEqual(body["HostConfig"][key], self.raw["HostConfig"][key])
                self.assertEqual(body["NetworkingConfig"]["EndpointsConfig"]["runtipi-network"]["IPAMConfig"], {"IPv4Address": "172.29.64.4"})
                self.assertEqual(REPLACE.candidate(self.record, self.reader)["Id"], NEW)
        self.assertEqual(self.raw, before)

    def test_normal_activation_restores_ports_without_installer_flags(self):
        body = self.create("normal")
        environment = dict(item.split("=", 1) for item in body["Env"])
        self.assertNotIn("ORBIS_INSTALLER_PHASE", environment)
        self.assertNotIn("ORBIS_INSTALLER_TRANSACTION", environment)
        self.assertEqual(body["HostConfig"]["PortBindings"], self.raw["HostConfig"]["PortBindings"])

    def test_target_defaults_replace_old_image_defaults_and_user_overrides_survive(self):
        body = self.create("hold")
        self.assertEqual(body["Cmd"], ["new-main"])
        self.assertEqual(body["Entrypoint"], ["new-entry"])
        environment = dict(item.split("=", 1) for item in body["Env"])
        self.assertEqual(environment["PATH"], "/new")
        self.assertEqual(environment["PRIVATE_SETTING"], "private-fixture-value")
        self.assertEqual(environment["NEW_DEFAULT"], "present")
        self.assertEqual(body["Labels"]["user-label"], "retained")
        self.assertEqual(body["Labels"]["org.opencontainers.image.version"], TARGET["tag"])

    def test_explicit_custom_command_is_preserved(self):
        self.raw["Config"]["Cmd"] = ["custom-command"]
        self.record["quiescedConfiguration"] = REPLACE.APPS.digest({key: self.raw[key] for key in ("Config", "HostConfig")})
        self.assertEqual(self.create("hold")["Cmd"], ["custom-command"])

    def test_engine_oom_default_is_normalized_without_changing_explicit_preferences(self):
        for setting, expected in [(None, False), (False, False), (True, True)]:
            self.raw["HostConfig"]["OomKillDisable"] = setting
            self.record["quiescedConfiguration"] = REPLACE.APPS.digest({key: self.raw[key] for key in ("Config", "HostConfig")})
            with self.subTest(setting=setting):
                self.assertEqual(self.create("hold")["HostConfig"]["OomKillDisable"], expected)

    def test_wrong_transaction_image_or_phase_is_not_removed_or_adopted(self):
        for key, value in [("Image", "sha256:" + "f" * 64), ("transaction", "another"), ("phase", "normal")]:
            self.create("hold")
            if key == "Image": self.created["Image"] = value
            else: self.created["Config"]["Labels"]["io.orbis.installation." + key] = value
            with self.subTest(key=key), self.assertRaisesRegex(REPLACE.ReplacementError, "differs"):
                REPLACE.candidate(self.record, self.reader)

    def test_unrecorded_created_container_must_match_full_creation_intent(self):
        self.create("hold")
        self.created["HostConfig"]["Binds"].append("/unreviewed:/data/extra:rw")
        with self.assertRaisesRegex(REPLACE.ReplacementError, "host settings"):
            REPLACE.candidate(self.record, self.reader)

    def test_rejected_owned_creation_can_be_removed_without_starting_it(self):
        with tempfile.TemporaryDirectory() as folder:
            self.record["review"]["journal"] = str(Path(folder) / "journal.json")
            def create(_name, body):
                self.created = {"Id": NEW, "Image": NEW_IMAGE, "Name": "/runtipi", "State": {"Status": "created"}, "Config": {key: value for key, value in body.items() if key not in {"HostConfig", "NetworkingConfig"}}, "HostConfig": copy.deepcopy(body["HostConfig"]), "NetworkSettings": copy.deepcopy(self.raw["NetworkSettings"])}
                self.created["HostConfig"]["Memory"] += 1
                self.reader.rows = [{"id": NEW, "name": "runtipi"}]
                return NEW
            self.reader.change = mock.Mock()
            with mock.patch.object(REPLACE, "Engine") as engine:
                engine.return_value.create.side_effect = create
                with self.assertRaisesRegex(REPLACE.ReplacementError, "host settings"):
                    REPLACE.create_candidate(self.record, self.reader, "hold")
            self.assertEqual(self.record["candidate"]["id"], NEW)
            self.assertFalse(self.record["candidate"]["validated"])
            self.assertEqual(self.reader.change.call_count, 0)
            REPLACE.remove_candidate(self.record, self.reader)
            self.assertEqual(self.reader.change.call_args_list, [mock.call(["update", "--restart", "no", NEW]), mock.call(["rm", NEW])])

    def test_known_candidate_definition_drift_is_refused(self):
        self.create("normal")
        self.record["candidate"] = {"id": NEW, "definition": REPLACE.candidate_definition(self.created)}
        self.created["HostConfig"]["Memory"] += 1
        with self.assertRaisesRegex(REPLACE.ReplacementError, "definition changed"):
            REPLACE.candidate(self.record, self.reader)

    def test_interruption_after_policy_restore_does_not_invalidate_known_candidate(self):
        self.create("normal")
        self.record["candidate"] = {"id": NEW, "definition": REPLACE.candidate_definition(self.created)}
        self.created["HostConfig"]["RestartPolicy"] = {"Name": "unless-stopped", "MaximumRetryCount": 0}
        self.assertEqual(REPLACE.candidate(self.record, self.reader)["Id"], NEW)
        self.created["HostConfig"]["RestartPolicy"] = {"Name": "always", "MaximumRetryCount": 0}
        with self.assertRaisesRegex(REPLACE.ReplacementError, "restart policy"):
            REPLACE.candidate(self.record, self.reader)

    def test_engine_unset_oom_default_is_stable_across_create_start_and_recovery(self):
        self.create("normal")
        self.record["candidate"] = {"id": NEW, "definition": REPLACE.candidate_definition(self.created)}
        self.created["HostConfig"]["OomKillDisable"] = None
        self.created["State"]["Status"] = "running"
        self.assertEqual(REPLACE.candidate(self.record, self.reader)["Id"], NEW)
        self.created["HostConfig"]["OomKillDisable"] = True
        with self.assertRaisesRegex(REPLACE.ReplacementError, "definition changed"):
            REPLACE.candidate(self.record, self.reader)

    def test_retained_original_cannot_start_or_change_configuration(self):
        self.raw["State"]["Status"] = "running"
        with self.assertRaisesRegex(REPLACE.ReplacementError, "stopped"):
            self.create("hold")
        self.raw["State"]["Status"] = "exited"
        self.raw["Config"]["Env"].append("CHANGED=1")
        with self.assertRaisesRegex(REPLACE.ReplacementError, "configuration changed"):
            self.create("hold")

    def test_creation_payload_and_secret_values_are_not_persisted_in_journal(self):
        self.create("hold")
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "journal.json"
            self.record["review"]["journal"] = str(path)
            REPLACE.save(self.record)
            text = path.read_text()
            self.assertNotIn("private-fixture-value", text)
            self.assertNotIn("PRIVATE_SETTING", text)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_public_activation_cannot_be_silently_rewound(self):
        self.record["stage"] = "committing"
        with self.assertRaisesRegex(REPLACE.ReplacementError, "Public activation has begun"):
            REPLACE.rollback(self.record, self.reader)

    def test_commit_is_durable_before_an_application_port_can_open(self):
        class StopBeforeActivation(BaseException):
            pass
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "journal.json"
            self.record["review"]["journal"] = str(path)
            def start(record, _reader, roles):
                self.assertIn("app", roles)
                self.assertEqual(json.loads(path.read_text())["stage"], "committing")
                raise StopBeforeActivation()
            with mock.patch.object(REPLACE, "check_originals"), mock.patch.object(REPLACE, "start_originals", side_effect=start):
                with self.assertRaises(StopBeforeActivation):
                    REPLACE.finish(self.record, self.reader)


if __name__ == "__main__":
    unittest.main()
