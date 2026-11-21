import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SPEC = importlib.util.spec_from_file_location("orbis_host_packages", Path(__file__).with_name("orbis-host-packages.py"))
assert SPEC and SPEC.loader
PACKAGES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGES)


def package(name="service:arm64", *, security=True):
    origins = [SimpleNamespace(origin="Ubuntu", archive="noble-security" if security else "noble-updates", site="ports.ubuntu.com", trusted=True)]
    return SimpleNamespace(
        name=name.split(":")[0],
        fullname=name,
        is_installed=True,
        is_upgradable=True,
        installed=SimpleNamespace(version="1.0"),
        candidate=SimpleNamespace(version="1.1", size=12000, is_security_update=security, origins=origins),
    )


class HostPackagesTests(unittest.TestCase):
    def test_smart_review_rejects_untrusted_candidates_and_unrelated_apt_operations(self):
        smart = package("smartmontools")
        smart.is_installed = False
        selected = {"name": "smartmontools", "installedVersion": None, "candidateVersion": "1.1"}
        install = {**selected, "action": "install"}
        with mock.patch.object(PACKAGES, "require_ubuntu", return_value={"VERSION_CODENAME": "noble"}), mock.patch.object(
            PACKAGES, "apt_module", return_value=SimpleNamespace(Cache=lambda: {"smartmontools": smart})
        ), mock.patch.object(PACKAGES, "simulate_install", return_value={"operations": [install]}) as simulate:
            self.assertEqual(PACKAGES.simulate_smart_tools(), {"selected": [selected], "operations": [install]})
            simulate.assert_called_once_with([selected], new_packages=True)
            simulate.return_value = {"operations": [install, {**install, "name": "other"}]}
            with self.assertRaisesRegex(ValueError, "outside"):
                PACKAGES.simulate_smart_tools()
            smart.candidate.origins[0].trusted = False
            with self.assertRaisesRegex(ValueError, "no trusted Ubuntu candidate"):
                PACKAGES.simulate_smart_tools()

    def test_inventory_reports_candidate_versions_origins_and_cache_age(self):
        cache = [package(), package("tool:arm64", security=False)]
        result = PACKAGES.inventory_from_cache(
            cache,
            {"PRETTY_NAME": "Ubuntu 24.04.4 LTS"},
            checked_at="2026-10-15T00:00:00+00:00",
            indexes_at="2026-10-14T00:00:00+00:00",
            reboot_required=True,
        )
        self.assertEqual(result["packageCount"], 2)
        self.assertEqual(result["packages"][0]["name"], "service:arm64")
        self.assertEqual(result["packages"][0]["installedVersion"], "1.0")
        self.assertEqual(result["packages"][0]["candidateVersion"], "1.1")
        self.assertEqual(result["packages"][0]["downloadBytes"], 12000)
        self.assertEqual(result["packages"][0]["sources"][0]["archive"], "noble-security")
        self.assertTrue(result["rebootRequired"])
        self.assertNotEqual(result["checkedAt"], result["indexesUpdatedAt"])

    def test_non_upgradeable_packages_do_not_enter_inventory(self):
        not_installed = package("absent:arm64")
        not_installed.is_installed = False
        held = package("held:arm64")
        held.is_upgradable = False
        result = PACKAGES.inventory_from_cache(
            [not_installed, held], {}, checked_at="now", indexes_at=None, reboot_required=False
        )
        self.assertEqual(result["packageCount"], 0)

    def test_changelog_requires_a_current_candidate_and_passes_no_shell_arguments(self):
        item = package()
        cache = {item.fullname: item}
        with mock.patch.object(PACKAGES, "require_ubuntu"), mock.patch.object(PACKAGES, "apt_module", return_value=SimpleNamespace(Cache=lambda: cache)):
            with self.assertRaisesRegex(ValueError, "invalid"):
                PACKAGES.changelog("service;rm")
            with self.assertRaisesRegex(ValueError, "not in"):
                PACKAGES.changelog("missing:arm64")
            with tempfile.TemporaryFile() as output:
                output.write(b"service (1.1) noble; urgency=medium\n\n  * Fixed issue\n")
                output.seek(0)
                with mock.patch.object(PACKAGES.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
                    with mock.patch.object(PACKAGES.tempfile, "TemporaryFile", side_effect=lambda: output):
                        result = PACKAGES.changelog(item.fullname)
                self.assertTrue(result["available"])
                self.assertEqual(run.call_args.args[0], ["/usr/bin/apt-get", "changelog", "service:arm64=1.1"])

    def test_simulation_reviews_exact_pinned_upgrade_and_implicit_install(self):
        selected = PACKAGES.selected_candidates(["service:arm64"], {"service:arm64": package()})
        self.assertEqual(
            PACKAGES.apt_install_command(selected, simulate=True),
            ["/usr/bin/apt-get", "--no-remove", "--no-install-recommends", "--simulate", "install", "--only-upgrade", "--", "service:arm64=1.1"],
        )
        self.assertEqual(PACKAGES.apt_apply_command(selected)[-3:], ["--only-upgrade", "--", "service:arm64=1.1"])
        self.assertIn("Dpkg::Options::=--force-confold", PACKAGES.apt_apply_command(selected))
        operations = PACKAGES.parse_simulation(
            "Inst dependency (2.0 Ubuntu:24.04/noble-updates [arm64])\nInst service [1.0] (1.1 Ubuntu:24.04/noble-updates [arm64])\n",
            selected,
        )
        self.assertEqual([operation["action"] for operation in operations], ["install", "upgrade"])
        with self.assertRaisesRegex(ValueError, "removal"):
            PACKAGES.parse_simulation("Remv service [1.0]\n", selected)
        with self.assertRaisesRegex(ValueError, "omitted"):
            PACKAGES.parse_simulation("Inst other [1.0] (1.1 Ubuntu:24.04/noble-updates [arm64])\n", selected)

    def test_simulation_accepts_apt_transient_dependency_annotations(self):
        selected = [{"name": "service:arm64", "candidateVersion": "1:1.1~noble+1"}]
        operations = PACKAGES.parse_simulation(
            "Inst dependency (2.0 Ubuntu:24.04/noble-updates [arm64]) [service:arm64 helper:arm64 ]\n"
            "Inst service [1.0] (1:1.1~noble+1 Ubuntu:24.04/noble-updates [arm64]) "
            "[service:arm64 on dependency:arm64] []\n"
            "Conf dependency (2.0 Ubuntu:24.04/noble-updates [arm64])\n",
            selected,
        )
        self.assertEqual(operations, [
            {"name": "dependency", "installedVersion": None, "candidateVersion": "2.0", "action": "install"},
            {"name": "service", "installedVersion": "1.0", "candidateVersion": "1:1.1~noble+1", "action": "upgrade"},
        ])

    def test_simulation_annotations_do_not_allow_unknown_actions_or_changed_candidates(self):
        selected = [{"name": "service", "candidateVersion": "1.1"}]
        install = "Inst service [1.0] (1.1 Ubuntu:24.04/noble-updates [arm64])"
        for suffix in [" arbitrary", " [--option ]", " [service:arm64 does dependency:arm64]"]:
            with self.subTest(suffix=suffix), self.assertRaisesRegex(ValueError, "unrecognized install"):
                PACKAGES.parse_simulation(install + suffix, selected)
        for action in ["Remv", "Purg"]:
            with self.subTest(action=action), self.assertRaisesRegex(ValueError, "removal"):
                PACKAGES.parse_simulation(install + " []\n" + action + " other [2.0]\n", selected)
        with self.assertRaisesRegex(ValueError, "omitted or changed"):
            PACKAGES.parse_simulation(install.replace("(1.1", "(1.2") + " []", selected)

    def test_inventory_distinguishes_ready_deferred_and_unknown(self):
        cache = [package("service:arm64"), package("service:amd64"), package("deferred:arm64")]
        common = {"checked_at": "now", "indexes_at": None, "reboot_required": False}
        operations = [{"name": "service", "installedVersion": "1.0", "candidateVersion": "1.1", "action": "upgrade"}]
        result = PACKAGES.inventory_from_cache(cache, {}, **common, ready_operations=operations, native_architecture="arm64")
        self.assertEqual((result["packageCount"], result["readyPackageCount"], result["deferredPackageCount"]), (3, 1, 2))
        self.assertEqual([(item["name"], item["ready"]) for item in result["packages"]], [
            ("service:arm64", True), ("deferred:arm64", False), ("service:amd64", False),
        ])
        unavailable = PACKAGES.inventory_from_cache(cache, {}, **common)
        self.assertEqual(unavailable["readiness"], "unavailable")
        self.assertNotIn("readyPackageCount", unavailable)
        self.assertTrue(all("ready" not in item for item in unavailable["packages"]))

    def test_normal_upgrade_accepts_no_work_with_timeout_below_inventory_transport(self):
        with mock.patch.object(PACKAGES, "run_simulation", return_value="0 upgraded, 0 newly installed, 0 to remove.\n") as simulate:
            self.assertEqual(PACKAGES.normal_upgrade_operations(), [])
            simulate.assert_called_once_with(["/usr/bin/apt-get", "--simulate", "--no-remove", "upgrade"], 15)

    def test_upgrade_rejects_deferred_selection_and_implicit_upgrade_but_keeps_reviewed_install(self):
        cache = {name: package(name) for name in ("service:arm64", "deferred:arm64")}
        ready = {"name": "service", "installedVersion": "1.0", "candidateVersion": "1.1", "action": "upgrade"}
        new_dependency = {"name": "dependency", "installedVersion": None, "candidateVersion": "2.0", "action": "install"}
        deferred = {**ready, "name": "deferred"}
        with mock.patch.object(PACKAGES, "require_ubuntu"), mock.patch.object(
            PACKAGES, "apt_module", return_value=SimpleNamespace(Cache=lambda: cache)
        ), mock.patch.object(PACKAGES, "native_apt_architecture", return_value="arm64"), mock.patch.object(
            PACKAGES, "normal_upgrade_operations", return_value=[ready]
        ), mock.patch.object(PACKAGES, "simulate_install") as simulate:
            with self.assertRaisesRegex(ValueError, "deferring"):
                PACKAGES.simulate_upgrades(["deferred:arm64"])
            simulate.assert_not_called()
            simulate.side_effect = [
                {"operations": [ready.copy(), deferred]},
                {"operations": [ready.copy(), new_dependency]},
                {"operations": [{**ready, "name": "service:amd64"}]},
            ]
            with self.assertRaisesRegex(ValueError, "outside"):
                PACKAGES.simulate_upgrades(["service:arm64"])
            result = PACKAGES.simulate_upgrades(["service:arm64"])
            self.assertEqual(result["operations"], [{**ready, "name": "service:arm64"}, new_dependency])
            with self.assertRaisesRegex(ValueError, "outside"):
                PACKAGES.simulate_upgrades(["service:arm64"])

    def test_simulation_rejects_malformed_or_untrusted_selection(self):
        item = package()
        with self.assertRaisesRegex(ValueError, "distinct"):
            PACKAGES.selected_candidates([item.fullname, item.fullname], {item.fullname: item})
        with self.assertRaisesRegex(ValueError, "invalid"):
            PACKAGES.selected_candidates(["--option"], {item.fullname: item})
        item.candidate.origins[0].trusted = False
        with self.assertRaisesRegex(ValueError, "trusted"):
            PACKAGES.selected_candidates([item.fullname], {item.fullname: item})


if __name__ == "__main__":
    unittest.main()
