#!/usr/bin/env python3
"""Publish the newest source-verified release launcher at a stable Pages URL."""

import argparse
import ast
from functools import cmp_to_key
import importlib.util
import json
from pathlib import Path
import re
import subprocess


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BUILD = load("orbis-installer-bundle")
BOOT = load("install-orbis")
POLICY = load("orbis-release-policy")
BASE = "https://github.com/twentylines/orbis/releases/"
LIMITS = {"install-orbis.py": 1024 * 1024, "release-manifest.json": 16 * 1024, BUILD.MANIFEST: 64 * 1024, BUILD.ARCHIVE: 8 * 1024 * 1024}


def compare_releases(first, second):
    order = POLICY.version_order(first["tag_name"], second["tag_name"])
    if order is None:
        raise ValueError("Release has an invalid published tag")
    return order


def newest(releases, channel="stable"):
    if not isinstance(releases, list) or len(releases) > 100:
        raise ValueError("Expected at most 100 published releases")
    if channel not in ("stable", "nightly"):
        raise ValueError("Release channel must be Stable or Nightly")
    candidates = [
        item for item in releases
        if isinstance(item, dict)
        and item.get("draft") is False
        and item.get("published_at")
        and POLICY.release_allowed_on_channel(item.get("tag_name"), channel)
    ]
    if not candidates:
        raise ValueError(f"No published {channel.title()} Orbis release is available")
    return max(candidates, key=cmp_to_key(compare_releases))


def tag_commit(repository, tag):
    return subprocess.check_output(["git", "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"], cwd=repository, text=True).strip()


def required_sources(source):
    tree = ast.parse(source["scripts/orbis-installer-bundle.py"])
    values = [node.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "REQUIRED" for target in node.targets)]
    if len(values) != 1:
        raise ValueError("Published source has no unique installer file list")
    return ast.literal_eval(values[0])


def site(repository, releases, output, fetch=BOOT.fetch, *, channel="stable"):
    selected = newest(releases, channel)
    tag = selected["tag_name"]
    if selected.get("html_url") != BASE + "tag/" + tag:
        raise ValueError("Release belongs to a different repository")
    assets = selected.get("assets")
    if not isinstance(assets, list):
        raise ValueError("Newest release has no installer assets")
    downloaded = {}
    for name, limit in LIMITS.items():
        matches = [item for item in assets if isinstance(item, dict) and item.get("name") == name]
        if len(matches) != 1:
            raise ValueError(f"Newest release is missing a unique {name}; publication may still be running")
        asset = matches[0]
        url = BASE + "download/" + tag + "/" + name
        if asset.get("browser_download_url") != url or asset.get("state") != "uploaded" or type(asset.get("size")) is not int or not 0 < asset["size"] <= limit or not re.fullmatch(r"sha256:[0-9a-f]{64}", str(asset.get("digest", ""))):
            raise ValueError("Newest release has invalid or incomplete installer assets")
        content = fetch(url, limit)
        if len(content) != asset["size"] or BUILD.sha(content) != asset["digest"][7:]:
            raise ValueError("Downloaded installer asset differs from GitHub's digest")
        downloaded[name] = content
    release = json.loads(downloaded["release-manifest.json"])
    if release.get("tag") != tag:
        raise ValueError("Installer and selected release have different tags")
    if tag_commit(repository, tag) != release.get("commit"):
        raise ValueError("Release source differs from the published Git tag")
    source = BUILD.committed_files(repository, release.get("commit", ""))
    identity = {"tag": tag, "commit": release["commit"], "manifestSha256": BUILD.sha(downloaded[BUILD.MANIFEST])}
    manifest = BOOT.verify_manifest(downloaded[BUILD.MANIFEST], identity, required=required_sources(source))
    if manifest["releaseManifestSha256"] != BUILD.sha(downloaded["release-manifest.json"]):
        raise ValueError("Installer and core image manifests do not match")
    verified = BOOT.verify_files(downloaded[BUILD.ARCHIVE], manifest)
    expected = {name: data for name, data in source.items() if BUILD.ALLOWED.fullmatch(name)}
    launcher = BUILD.release_launcher(source["scripts/" + BUILD.LAUNCHER], identity)
    if verified != expected or downloaded[BUILD.LAUNCHER] != launcher:
        raise ValueError("Published installer differs from its committed source")
    output.mkdir(parents=True, exist_ok=False)
    (output / "install").write_bytes(downloaded[BUILD.LAUNCHER])
    (output / "latest.json").write_text(json.dumps({"schema": "orbis.installer-channel.v1", "channel": channel, "tag": tag, "commit": release["commit"], "launcherSha256": BUILD.sha(downloaded[BUILD.LAUNCHER]), "releaseUrl": selected["html_url"]}, indent=2) + "\n")
    (output / ".nojekyll").touch()
    (output / "index.html").write_text('<!doctype html><meta charset="utf-8"><title>Orbis</title><meta http-equiv="refresh" content="0;url=' + selected["html_url"] + '"><a href="' + selected["html_url"] + '">Orbis releases</a>\n')
    return {"channel": channel, "tag": tag, "commit": release["commit"], "launcherSha256": BUILD.sha(downloaded[BUILD.LAUNCHER])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("releases", type=Path, help="GitHub release-list JSON, fetched with repository read access")
    parser.add_argument("output", type=Path, help="new directory containing only the public installer endpoint")
    parser.add_argument("--channel", choices=("stable", "nightly"), default="stable", help="select Stable (default) or Nightly")
    args = parser.parse_args()
    print(json.dumps(site(Path(__file__).resolve().parent.parent, json.loads(args.releases.read_text()), args.output, channel=args.channel), indent=2))


if __name__ == "__main__":
    main()
