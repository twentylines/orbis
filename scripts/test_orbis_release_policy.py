import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("orbis_release_policy", Path(__file__).with_name("orbis-release-policy.py"))
assert SPEC and SPEC.loader
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)
FIXTURES = json.loads((ROOT / "packages/common/src/schemas/fixtures/orbis-release-policy.json").read_text(encoding="utf-8"))


class OrbisReleasePolicyTests(unittest.TestCase):
    def test_shared_version_classification_fixtures(self):
        for case in FIXTURES["versions"]:
            with self.subTest(version=case["version"]):
                parsed = POLICY.parse_version(case["version"])
                self.assertEqual(parsed, case["parsed"])
                self.assertEqual(POLICY.is_published_release_tag(case["version"]), case["published"])
                self.assertEqual(POLICY.is_stable_release_tag(case["version"]), case["stable"])
                for channel in ("stable", "nightly"):
                    self.assertEqual(POLICY.release_allowed_on_channel(case["version"], channel), case[channel])

    def test_shared_downgrade_fixtures(self):
        for case in FIXTURES["downgrades"]:
            with self.subTest(case=case):
                self.assertEqual(
                    POLICY.downgrade_allowed_on_channel(case["target"], case["installed"], case["channel"]),
                    case["allowed"],
                )

    def test_version_order_uses_numeric_base_and_beta_rc_stable_precedence(self):
        for case in FIXTURES["order"]:
            with self.subTest(case=case):
                self.assertEqual(POLICY.version_order(case["first"], case["second"]), case["result"])


if __name__ == "__main__":
    unittest.main()
