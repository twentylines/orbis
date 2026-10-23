import importlib.util
import json
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("install_compat", __import__('pathlib').Path(__file__).with_name("orbis-install-compat.py"))
assert SPEC and SPEC.loader
COMPAT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(COMPAT)


def migration(number):
    return {"createdAt": 1700000000000 + number, "hash": f"{number:064x}"}


class Reader:
    def __init__(self, value):
        self.value = value
        self.calls = []

    def _read(self, args):
        self.calls.append(args)
        return json.dumps(self.value)


class CompatibilityTests(unittest.TestCase):
    def test_logging_defaults_are_bounded_and_contain_no_option_values(self):
        value = {"Type": "logging-plugin:1", "Config": {"token": "private-fixture-value", "endpoint": "private-fixture-endpoint"}}
        result = COMPAT.logging_defaults(value)
        self.assertEqual(result["driver"], "logging-plugin:1")
        self.assertEqual(set(result["options"]), {"token", "endpoint"})
        self.assertNotIn("private-fixture", json.dumps(result))
        for invalid in ({}, {"Type": "bad\nname"}, {"Type": "json-file", "Config": []}, {"Type": "json-file", "Config": {"limit": 3}}, {"Type": "json-file", "Config": {"limit": "x" * 16385}}):
            with self.subTest(invalid_type=type(invalid)), self.assertRaises(COMPAT.CompatibilityError):
                COMPAT.logging_defaults(invalid)

    def test_existing_image_probe_seals_the_original_logging_driver_defaults(self):
        target = {"image": "ghcr.io/twentylines/orbis", "digest": "sha256:" + "a" * 64, "commit": "b" * 40}
        identifier, image_id, token = "c" * 64, "sha256:" + "d" * 64, "probe-token"
        class Probe:
            def __init__(self): self.calls = []
            def _object(self, args):
                self.calls.append(args)
                if args[0] == "image": return {"id": image_id, "os": "linux", "labels": {"org.opencontainers.image.revision": target["commit"]}}
                return {"Type": "json-file", "Config": {"max-size": "10m"}}
            def _read(self, args):
                self.calls.append(args)
                return identifier if args[1] == "create" else json.dumps([migration(1)])
            def app(self, key):
                assert key == identifier
                return {"imageId": image_id, "labels": {"io.orbis.installation.probe": token}, "state": "exited"}
            def change(self, args): self.calls.append(args)
        probe = Probe()
        with mock.patch.object(COMPAT.uuid, "uuid4", return_value=token):
            result = COMPAT.image_ledger(probe, target, logging_driver="json-file")
        create = next(call for call in probe.calls if call[:2] == ["container", "create"])
        self.assertEqual(create[create.index("--log-driver") + 1], "json-file")
        self.assertEqual(result["loggingDefaults"], COMPAT.logging_defaults({"Type": "json-file", "Config": {"max-size": "10m"}}))
        self.assertNotIn("10m", json.dumps(result))
        self.assertEqual(probe.calls[-1], ["rm", identifier])

    def test_known_prefix_and_exact_history_are_compatible(self):
        target = [migration(1), migration(2)]
        COMPAT.require_compatible(target[:1], target)
        COMPAT.require_compatible(target, target)

    def test_newer_history_and_different_hashes_are_refused(self):
        target = [migration(1), migration(2)]
        for installed in [[*target, migration(3)], [migration(1), {**migration(2), "hash": "f" * 64}], [migration(2)]]:
            with self.subTest(installed=installed), self.assertRaisesRegex(COMPAT.CompatibilityError, "newer or different"):
                COMPAT.require_compatible(installed, target)

    def test_missing_duplicate_reordered_or_invalid_ledger_is_refused(self):
        for value in [[], None, {}, [migration(1)] * 2, [migration(2), migration(1)], [{**migration(1), "createdAt": True}], [{**migration(1), "createdAt": 2**54}], [{**migration(1), "hash": "not-a-hash"}], [{**migration(1), "sql": "not accepted"}]]:
            with self.subTest(value=value), self.assertRaises(COMPAT.CompatibilityError):
                COMPAT.ledger(value)

    def test_busy_application_state_is_not_accepted(self):
        for pending in [1, True, -1, None]:
            with self.subTest(pending=pending), self.assertRaisesRegex(COMPAT.CompatibilityError, "pending app"):
                COMPAT.database(Reader({"ledger": [migration(1)], "pendingApps": pending, "postgresMajor": 14}), "database")

    def test_database_inventory_has_no_writes_or_environment_queries(self):
        reader = Reader({"ledger": [migration(1)], "pendingApps": 0, "postgresMajor": 14})
        result = COMPAT.database(reader, "database")
        self.assertEqual(result["ledger"], [migration(1)])
        sql = reader.calls[0][-1]
        self.assertNotIn("password", sql)
        self.assertNotIn("DELETE", sql)
        self.assertNotIn("UPDATE", sql)
        self.assertEqual(reader.calls[0][0:2], ["exec", "database"])

    def test_message_or_unacknowledged_work_is_never_purged(self):
        for key in ["messages_ready", "messages_unacknowledged", "consumers"]:
            state = {"name": "app-events-queue", "messages_ready": 0, "messages_unacknowledged": 0, "consumers": 0, key: 1}
            reader = Reader([state])
            with self.subTest(key=key), self.assertRaisesRegex(COMPAT.CompatibilityError, "no messages were removed"):
                COMPAT.idle_app_queue(reader, "queue", stopped_controller=True)
            self.assertEqual(len(reader.calls), 1)
            self.assertIn("list_queues", reader.calls[0])

    def test_live_original_consumer_is_allowed_only_before_shutdown(self):
        state = {"name": "app-events-queue", "messages_ready": 0, "messages_unacknowledged": 0, "consumers": 1}
        COMPAT.idle_app_queue(Reader([state]), "queue", stopped_controller=False)

    def test_unknown_missing_and_malformed_queue_results_are_rejected(self):
        base = {"name": "app-events-queue", "messages_ready": 0, "messages_unacknowledged": 0, "consumers": 0}
        for value in [[], {}, [base, base], [{**base, "messages_ready": False}], [{**base, "consumers": -1}]]:
            with self.subTest(value=value), self.assertRaises(COMPAT.CompatibilityError):
                COMPAT.idle_app_queue(Reader(value), "queue", stopped_controller=True)

    def test_json_and_history_limits_are_enforced(self):
        with self.assertRaises(COMPAT.CompatibilityError): COMPAT.bounded_json('"' + 'x' * (512 * 1024) + '"')
        with self.assertRaises(COMPAT.CompatibilityError): COMPAT.bounded_json('{')
        with self.assertRaises(COMPAT.CompatibilityError): COMPAT.ledger([migration(i) for i in range(4097)])


if __name__ == "__main__":
    unittest.main()
