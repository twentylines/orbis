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


if __name__ == "__main__":
    unittest.main()
