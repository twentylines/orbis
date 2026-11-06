#!/usr/bin/env python3
"""Publish the HEAD-bound installer and newest verified release launchers at a stable Pages URL."""

import argparse
import ast
import io
from functools import cmp_to_key
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.error import HTTPError


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BUILD = load("orbis-installer-bundle")
BOOT = load("install-orbis")
POLICY = load("orbis-release-policy")
BASE = "https://github.com/twentylines/orbis/releases/"
LEGACY_CHANNEL_BOOTSTRAPS = {"v0.1.0-beta.125": "5b0a23548769d6046d12e0273e135fddbcbf1a63f2d1c537ccc7987da59d892f"}
LIMITS = {"install-orbis.py": 1024 * 1024, "release-manifest.json": 16 * 1024, BUILD.MANIFEST: 64 * 1024, BUILD.ARCHIVE: 8 * 1024 * 1024}
HISTORY = 'installer-history.json'
PAGES = 'https://twentylines.github.io/orbis/'


class NoPublishedRelease(ValueError):
    pass


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
        raise NoPublishedRelease(f"No published {channel.title()} Orbis release is available")
    return max(candidates, key=cmp_to_key(compare_releases))


def tag_commit(repository, tag):
    return subprocess.check_output(["git", "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"], cwd=repository, text=True).strip()


def head_commit(repository):
    commit = subprocess.check_output(["git", "rev-parse", "--verify", "HEAD^{commit}"], cwd=repository, text=True).strip()
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("A full committed HEAD is required")
    return commit


def required_sources(source):
    return BUILD.source_required(source)


def packaged_sources(source):
    excluded = BUILD.source_excluded(source)
    return {name: body for name, body in source.items() if BUILD.ALLOWED.fullmatch(name) and name not in excluded}


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
    expected = packaged_sources(source)
    launcher = BUILD.release_launcher(source["scripts/" + BUILD.LAUNCHER], identity)
    if verified != expected or downloaded[BUILD.LAUNCHER] != launcher:
        raise ValueError("Published installer differs from its committed source")
    output.mkdir(parents=True, exist_ok=False)
    (output / "install").write_bytes(downloaded[BUILD.LAUNCHER])
    (output / "latest.json").write_text(json.dumps({"schema": "orbis.installer-channel.v1", "channel": channel, "tag": tag, "commit": release["commit"], "launcherSha256": BUILD.sha(downloaded[BUILD.LAUNCHER]), "releaseUrl": selected["html_url"]}, indent=2) + "\n")
    (output / ".nojekyll").touch()
    (output / "index.html").write_text('<!doctype html><meta charset="utf-8"><title>Orbis</title><meta http-equiv="refresh" content="0;url=' + selected["html_url"] + '"><a href="' + selected["html_url"] + '">Orbis releases</a>\n')
    return {"channel": channel, "tag": tag, "commit": release["commit"], "launcherSha256": BUILD.sha(downloaded[BUILD.LAUNCHER])}


def previous_installers(fetch):
    def optional(url, limit):
        try:
            return fetch(url, limit)
        except HTTPError as error:
            if error.code != 404:
                raise
            error.close()
            return None
    data = optional(PAGES + HISTORY, 128 * 1024)
    if data is not None:
        value = json.loads(data)
        if not isinstance(value, dict) or set(value) != {'schema', 'installers'} or value['schema'] != 'orbis.installer-history.v1':
            raise ValueError('The existing installer history is invalid')
        records = value['installers']
    else:
        bootstrap = optional(PAGES + 'install', 1024 * 1024)
        if bootstrap is None:
            return {}
        assignments = [node.value for node in ast.parse(bootstrap).body if isinstance(node, ast.Assign)
                       and any(isinstance(target, ast.Name) and target.id == 'INSTALLER' for target in node.targets)]
        if not assignments:
            return {}
        if len(assignments) != 1:
            raise ValueError('The existing installer has ambiguous source identity')
        identity = ast.literal_eval(assignments[0])
        if identity is None:
            return {}
        if not isinstance(identity, dict) or set(identity) != {'commit', 'manifestSha256'}:
            raise ValueError('The existing installer identity is invalid')
        records = {identity['commit']: identity['manifestSha256']}
    if (not isinstance(records, dict) or len(records) > 512 or any(
            not isinstance(commit, str) or not re.fullmatch(r'[0-9a-f]{40}', commit)
            or not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest) for commit, digest in records.items())):
        raise ValueError('The existing installer history exceeds its contract')
    return records


def preserve_installers(repository, staged, records, fetch):
    privacy = load('release-artifact-privacy')
    budget = privacy.Budget()
    total = 0
    for commit, digest in sorted(records.items()):
        subprocess.run(['git', 'merge-base', '--is-ancestor', commit, 'HEAD'], cwd=repository, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        source = BUILD.committed_files(repository, commit)
        _, schema = BUILD.source_contract(source)
        if schema is None:
            raise ValueError('Retained installer source has no independent format')
        base = BOOT.INSTALLER_BASE_URL + commit + '/'
        manifest_bytes = fetch(base + BUILD.MANIFEST, LIMITS[BUILD.MANIFEST])
        manifest = BOOT.verify_installer_manifest(manifest_bytes, {'commit': commit, 'manifestSha256': digest}, required=required_sources(source))
        if manifest['schema'] != schema:
            raise ValueError('Retained installer format differs from its source')
        archive = fetch(base + BUILD.ARCHIVE, manifest['archiveBytes'])
        verified = BOOT.verify_files(archive, manifest)
        if verified != packaged_sources(source):
            raise ValueError('Retained installer differs from its committed source')
        total += len(manifest_bytes) + len(archive)
        if total > 256 * 1024 * 1024:
            raise ValueError('Retained installer storage exceeds its publication limit')
        privacy.scan_stream(io.BytesIO(manifest_bytes), 'retained.manifest', budget)
        privacy.scan_stream(io.BytesIO(archive), 'retained.archive', budget)
        privacy.scan_tar(io.BytesIO(archive), 'retained.archive', budget, True)
        folder = staged / 'installer' / commit
        folder.mkdir(parents=True, exist_ok=True)
        for name, body in ((BUILD.MANIFEST, manifest_bytes), (BUILD.ARCHIVE, archive)):
            destination = folder / name
            if destination.exists() and destination.read_bytes() != body:
                raise ValueError('An immutable installer path has different bytes')
            destination.write_bytes(body)


def channel_site(repository, releases, output, fetch=BOOT.fetch, *, previous_fetch=None):
    catalog = {"schema": "orbis.installer-channels.v1", "channels": {"stable": None, "nightly": None}}
    with tempfile.TemporaryDirectory(prefix="orbis-channel-site-") as folder:
        staged = Path(folder) / "public"
        staged.mkdir()
        for channel in ("stable", "nightly"):
            try:
                newest(releases, channel)
            except NoPublishedRelease:
                continue
            checked = site(repository, releases, staged / channel, fetch, channel=channel)
            catalog["channels"][channel] = {key: checked[key] for key in ("tag", "commit", "launcherSha256")}
        record = catalog["channels"]["nightly"]
        if record is None:
            raise NoPublishedRelease("No published Orbis release is available")
        head = head_commit(repository)
        head_files = BUILD.committed_files(repository, head)
        source = head_files["scripts/install-orbis.py"]
        installer_identity = None
        history = previous_installers(previous_fetch) if previous_fetch is not None else {}
        if source.count(b"INSTALLER = None") == 1:
            if source.count(b"EXPECTED_RELEASE = None") != 1:
                raise ValueError("The committed installer does not support source-bound installation")
            assets = BUILD.build_installer(head_files, head)
            installer_identity = {"commit": head, "manifestSha256": BUILD.sha(assets[BUILD.MANIFEST])}
            bootstrap = source.replace(b"INSTALLER = None", ("INSTALLER = " + repr(installer_identity)).encode())
            if bootstrap.count(b"CHANNEL_CATALOG = None") == 1:
                bootstrap = bootstrap.replace(b"CHANNEL_CATALOG = None", ("CHANNEL_CATALOG = " + repr(catalog)).encode())
            installer_dir = staged / "installer" / head
            installer_dir.mkdir(parents=True)
            for name, data in assets.items():
                (installer_dir / name).write_bytes(data)
            if head in history and history[head] != installer_identity['manifestSha256']:
                raise ValueError('The current installer path is already pinned to different bytes')
        else:
            if source.count(b"CHANNEL_CATALOG = None") != 1 or source.count(b"EXPECTED_RELEASE = None") != 1:
                if source.count(b"CHANNEL_CATALOG = None") == 0 and source.count(b"EXPECTED_RELEASE = None") == 1 and LEGACY_CHANNEL_BOOTSTRAPS.get(record["tag"]) == BUILD.sha(source):
                    raise NoPublishedRelease(f"Verified release {record['tag']} predates channel-aware installation")
                raise ValueError("The committed installer does not support channel selection")
            bootstrap = source.replace(b"CHANNEL_CATALOG = None", ("CHANNEL_CATALOG = " + repr(catalog)).encode())
        compile(bootstrap, "install", "exec")
        if previous_fetch is not None:
            preserve_installers(repository, staged, history, previous_fetch)
        if installer_identity is not None:
            history[head] = installer_identity['manifestSha256']
        if len(history) > 512:
            raise ValueError('Installer history exceeds its publication limit')
        (staged / HISTORY).write_text(json.dumps({'schema': 'orbis.installer-history.v1', 'installers': history}, sort_keys=True, indent=2) + '\n')
        (staged / "install").write_bytes(bootstrap)
        (staged / "channels.json").write_text(json.dumps(catalog, indent=2) + "\n")
        (staged / ".nojekyll").touch()
        (staged / "index.html").write_text('<!doctype html><meta charset="utf-8"><title>Orbis</title><h1>Orbis</h1><p>Run the installer to choose Stable or Nightly.</p>\n')
        shutil.copytree(staged, output)
    result = {"channels": catalog["channels"], "launcherSha256": BUILD.sha(bootstrap)}
    if installer_identity is not None:
        result.update({"installerCommit": installer_identity["commit"], "installerManifestSha256": installer_identity["manifestSha256"]})
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("releases", type=Path, help="GitHub release-list JSON, fetched with repository read access")
    parser.add_argument("output", type=Path, help="new directory containing only the public installer endpoint")
    parser.add_argument("--channel", choices=("stable", "nightly"), default="stable", help="select Stable (default) or Nightly")
    parser.add_argument("--channels", action="store_true", help="publish one interactive installer and both verified channel endpoints")
    parser.add_argument("--preserve-installers", action="store_true", help="verify and retain URLs pinned by existing independent installers")
    parser.add_argument("--if-available", action="store_true", help="preserve the deployed endpoint when this channel has no release yet")
    parser.add_argument("--github-output", type=Path, help="append the verified availability flag to a workflow output file")
    args = parser.parse_args(argv)
    try:
        repository = Path(__file__).resolve().parent.parent
        releases = json.loads(args.releases.read_text())
        if args.preserve_installers and not args.channels:
            raise ValueError('Installer preservation requires the combined endpoint')
        checked = (channel_site(repository, releases, args.output, previous_fetch=BOOT.fetch) if args.preserve_installers
                   else channel_site(repository, releases, args.output)) if args.channels else site(repository, releases, args.output, channel=args.channel)
        result = {"available": True, **checked}
    except NoPublishedRelease as error:
        if not args.if_available:
            raise
        result = {"available": False, "channel": args.channel, "reason": str(error) + ". The existing endpoint is unchanged."}
    if args.github_output:
        with args.github_output.open("a") as output:
            output.write("available=" + str(result["available"]).lower() + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
