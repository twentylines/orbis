#!/usr/bin/env python3
"""Compute and publish the source-bound critical-through release marker."""

import argparse
from functools import cmp_to_key
import importlib.util
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path


POLICY_PATH = Path(__file__).with_name("orbis-release-policy.py")
SPEC = importlib.util.spec_from_file_location("orbis_release_policy", POLICY_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("release policy helper is unavailable")
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)

IMAGE = "ghcr.io/twentylines/orbis"
PAGE_SIZE = 100
MAX_PAGES = 2
MAX_RELEASES_BYTES = 2 * 1024 * 1024
MAX_MANIFEST_BYTES = 16 * 1024
MAX_CRITICAL_FIXES = 128
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")


def channel_for(tag: str) -> str:
    if not POLICY.is_published_release_tag(tag):
        raise ValueError("tag must be a strict published Orbis release tag")
    return "stable" if POLICY.is_stable_release_tag(tag) else "nightly"


def compute_critical_through(
    tag: str,
    channel: str,
    priority: str,
    inherited: list[dict[str, object]],
) -> str | None:
    """Compatibility wrapper for marker-only callers; promotion is explicit."""
    return compute_release_state(tag, channel, priority, inherited)[0]


def is_ancestor(tag: str, commit: str) -> bool:
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", tag, commit],
        capture_output=True,
        check=False,
        text=True,
        timeout=10,
    )
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    raise ValueError("release ancestry could not be verified")


def tag_commit(tag: str) -> str:
    result = subprocess.run(
        ["git", "rev-parse", "--verify", f"{tag}^{{commit}}"],
        capture_output=True,
        check=False,
        text=True,
        timeout=10,
    )
    commit = result.stdout.strip()
    if result.returncode != 0 or not COMMIT.fullmatch(commit):
        raise ValueError("release tag is missing from the checked-out source ancestry")
    return commit


def github_json(url: str, token: str, limit: int) -> object:
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/octet-stream" if "/releases/assets/" in url else "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Orbis-release-watermark/1",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            data = response.read(limit + 1)
    except (OSError, urllib.error.URLError) as error:
        raise ValueError("GitHub release metadata could not be read") from error
    if len(data) > limit:
        raise ValueError("GitHub release metadata exceeded its size limit")
    try:
        return json.loads(data)
    except json.JSONDecodeError as error:
        raise ValueError("GitHub returned invalid release metadata") from error


def release_pages(repository: str, token: str) -> list[dict[str, object]]:
    releases: list[dict[str, object]] = []
    for page in range(1, MAX_PAGES + 1):
        result = github_json(
            f"https://api.github.com/repos/{repository}/releases?per_page={PAGE_SIZE}&page={page}",
            token,
            MAX_RELEASES_BYTES,
        )
        if not isinstance(result, list) or len(result) > PAGE_SIZE:
            raise ValueError("GitHub returned an invalid release list")
        releases.extend(item for item in result if isinstance(item, dict))
        if len(result) < PAGE_SIZE:
            break
    return releases


def release_body_priority(body: object) -> str:
    if not isinstance(body, str) or len(body) > 64 * 1024:
        return "normal"
    priority = "normal"
    seen: set[str] = set()
    for _ in range(2):
        match = re.match(
            r"^[\t ]*<!--[\t ]*(orbis-release-kind|orbis-update-priority):[\t ]*"
            r"(feature|maintenance|critical|normal)[\t ]*-->[\t ]*\r?\n*",
            body,
        )
        if not match or match.group(1) in seen:
            break
        field, value = match.groups()
        if field == "orbis-release-kind" and value not in {"feature", "maintenance"}:
            break
        if field == "orbis-update-priority" and value not in {"critical", "normal"}:
            break
        seen.add(field)
        if field == "orbis-update-priority":
            priority = value
        body = body[match.end():]
    return priority


def previous_manifest(
    release: dict[str, object], repository: str, token: str, expected_channel: str
) -> dict[str, object] | None:
    tag = release.get("tag_name")
    if not isinstance(tag, str) or not POLICY.is_published_release_tag(tag):
        return None
    actual_channel = channel_for(tag)
    if actual_channel != expected_channel:
        return None
    assets = release.get("assets")
    if not isinstance(assets, list) or len(assets) > 256:
        return None
    asset = next(
        (item for item in assets if isinstance(item, dict) and item.get("name") == "release-manifest.json"),
        None,
    )
    if not isinstance(asset, dict) or type(asset.get("id")) is not int or asset["id"] <= 0:
        return None
    manifest = github_json(
        f"https://api.github.com/repos/{repository}/releases/assets/{asset['id']}",
        token,
        MAX_MANIFEST_BYTES,
    )
    if not isinstance(manifest, dict):
        return None
    tag_sha = tag_commit(tag)
    if (
        manifest.get("schema") != "orbis.release.v1"
        or manifest.get("image") != IMAGE
        or manifest.get("tag") != tag
        or manifest.get("commit") != tag_sha
        or ("releaseChannel" in manifest and manifest.get("releaseChannel") != actual_channel)
        or manifest.get("updatePriority", "normal") not in {"normal", "critical"}
    ):
        return None
    fixes = manifest.get("criticalFixes", [])
    if (
        not isinstance(fixes, list)
        or len(fixes) > MAX_CRITICAL_FIXES
        or any(not isinstance(fix, str) or not POLICY.is_published_release_tag(fix) for fix in fixes)
        or len(set(fixes)) != len(fixes)
    ):
        return None
    has_frontier = "criticalFixes" in manifest
    if "criticalThrough" in manifest:
        marker = manifest.get("criticalThrough")
        if marker is None:
            if has_frontier:
                return manifest
            if manifest.get("updatePriority") == "critical" or release_body_priority(release.get("body")) == "critical":
                return {**manifest, "criticalThrough": tag, "criticalFixes": [tag]}
            return None
        if (
            not POLICY.is_published_release_tag(marker)
            or not POLICY.release_allowed_on_channel(marker, actual_channel)
            or POLICY.version_order(marker, tag) not in (-1, 0)
        ):
            return None
        return manifest
    if manifest.get("updatePriority") == "critical" or release_body_priority(release.get("body")) == "critical":
        return {**manifest, "criticalThrough": tag, "criticalFixes": fixes or [tag]}
    # Old normal manifests cannot prove that an older critical tag is outside
    # the bounded discovery window. Keep searching until a watermark exists.
    return None


def inherited_markers(tag: str, commit: str, repository: str, token: str) -> list[dict[str, object]]:
    channel_for(tag)
    found: dict[str, tuple[str, str, dict[str, object]]] = {}
    releases = [release for release in release_pages(repository, token) if POLICY.is_published_release_tag(release.get("tag_name"))]
    releases.sort(key=cmp_to_key(lambda first, second: POLICY.version_order(second["tag_name"], first["tag_name"]) or 0))
    for release in releases:
        if release.get("draft") is True:
            continue
        previous_tag = release.get("tag_name")
        if not isinstance(previous_tag, str) or previous_tag == tag or not POLICY.is_published_release_tag(previous_tag):
            continue
        if POLICY.version_order(previous_tag, tag) not in (-1, 0):
            continue
        source_channel = channel_for(previous_tag)
        if not is_ancestor(previous_tag, commit):
            continue
        if source_channel in found:
            continue
        if release_body_priority(release.get("body")) == "critical":
            manifest = {"criticalThrough": previous_tag, "criticalFixes": [previous_tag]}
        else:
            manifest = previous_manifest(release, repository, token, source_channel)
            if manifest is None:
                raise ValueError("latest published channel release has no verifiable critical-fix frontier")
        value = manifest.get("criticalThrough")
        if value is not None:
            if value is not None and (
                not isinstance(value, str)
                or not POLICY.is_published_release_tag(value)
                or not POLICY.release_allowed_on_channel(value, source_channel)
                or POLICY.version_order(value, tag) not in (-1, 0)
                or not is_ancestor(value, commit)
            ):
                continue
        fixes = manifest.get("criticalFixes", [])
        if not isinstance(fixes, list):
            continue
        checked_fixes = [
            fix for fix in fixes
            if isinstance(fix, str)
            and POLICY.is_published_release_tag(fix)
            and is_ancestor(fix, commit)
        ]
        # A pre-frontier manifest may have only the old marker. Preserve it as
        # an origin during the one-time migration to criticalFixes.
        if not checked_fixes and isinstance(value, str):
            checked_fixes = [value]
        source_commit = tag_commit(previous_tag)
        current = found.get(source_channel)
        if current is None or POLICY.version_order(previous_tag, current[0]) == 1:
            found[source_channel] = (previous_tag, source_commit, {
                "criticalThrough": value,
                "criticalFixes": checked_fixes,
            })

    previous_channel = found.get(channel_for(tag))
    previous_channel_commit = previous_channel[1] if previous_channel else None
    inherited: list[dict[str, object]] = []
    for source_channel, (source_tag, _source_commit, manifest) in found.items():
        marker = manifest.get("criticalThrough")
        if source_channel == channel_for(tag) and isinstance(marker, str):
            inherited.append({"channel": source_channel, "criticalThrough": marker, "ancestor": True})
        for fix in manifest["criticalFixes"]:
            newly_introduced = False
            if source_channel != channel_for(tag):
                if previous_channel_commit is not None:
                    newly_introduced = not is_ancestor(fix, previous_channel_commit)
                else:
                    # A new channel has no installed-version baseline. Promote
                    # conservatively even when its first release shares the fix commit.
                    newly_introduced = True
            inherited.append({
                "tag": fix,
                "channel": source_channel,
                "ancestor": True,
                "newlyIntroduced": newly_introduced,
            })
    return inherited


def prune_fix_frontier(fixes: list[str]) -> list[str]:
    """Keep only source tags whose commits are not covered by a later fix tag."""
    unique = sorted(set(fixes), key=cmp_to_key(lambda first, second: POLICY.version_order(first, second) or 0))
    representatives: dict[str, str] = {}
    for fix in unique:
        representatives[tag_commit(fix)] = fix
    commits = list(representatives)
    frontier = [representatives[commit] for commit in commits if not any(
        commit != other and is_ancestor(representatives[commit], tag_commit(representatives[other]))
        for other in commits
    )]
    if len(frontier) > MAX_CRITICAL_FIXES:
        raise ValueError("critical fix frontier exceeds its size limit")
    return frontier


def compute_release_state(
    tag: str,
    channel: str,
    priority: str,
    inherited: list[dict[str, object]],
) -> tuple[str | None, list[str]]:
    if not POLICY.is_published_release_tag(tag) or channel_for(tag) != channel:
        raise ValueError("release channel does not match the published tag")
    if priority not in {"normal", "critical"}:
        raise ValueError("release priority is invalid")
    fixes = [
        item["tag"] for item in inherited
        if item.get("ancestor") is True
        and isinstance(item.get("tag"), str)
        and POLICY.is_published_release_tag(item["tag"])
    ]
    if priority == "critical":
        fixes.append(tag)
    if len(set(fixes)) > MAX_CRITICAL_FIXES:
        raise ValueError("critical fix frontier exceeds its size limit")
    marker_candidates = [
        item["criticalThrough"] for item in inherited
        if item.get("channel") == channel
        and isinstance(item.get("criticalThrough"), str)
        and POLICY.is_published_release_tag(item["criticalThrough"])
        and POLICY.version_order(item["criticalThrough"], tag) in (-1, 0)
        and POLICY.release_allowed_on_channel(item["criticalThrough"], channel)
    ]
    newly_introduced = any(item.get("newlyIntroduced") is True for item in inherited)
    if priority == "critical" or newly_introduced:
        marker: str | None = tag
    elif marker_candidates:
        marker = max(marker_candidates, key=cmp_to_key(lambda first, second: POLICY.version_order(first, second) or 0))
    else:
        marker = None
    return marker, fixes


def append_marker(notes_path: Path, output_path: Path, marker: str | None) -> None:
    try:
        raw = notes_path.read_bytes()
    except OSError as error:
        raise ValueError("release notes file cannot be read") from error
    if len(raw) > 64 * 1024:
        raise ValueError("release notes exceed 64 KiB")
    try:
        notes = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("release notes must be UTF-8") from error
    if marker is not None:
        if not POLICY.is_published_release_tag(marker):
            raise ValueError("critical-through marker is invalid")
        prefix = ""
        remaining = notes
        if remaining.startswith("\ufeff"):
            prefix, remaining = "\ufeff", remaining[1:]
        for _ in range(2):
            header = re.match(
                r"^[\t ]*<!--[\t ]*(orbis-release-kind|orbis-update-priority):[\t ]*"
                r"(feature|maintenance|critical|normal)[\t ]*-->[\t ]*\r?\n*",
                remaining,
            )
            if not header:
                break
            prefix += header.group(0)
            remaining = remaining[header.end():]
        notes = f"{prefix}<!-- orbis-critical-through: {marker} -->\n{remaining}"
    output_path.write_text(notes, encoding="utf-8", newline="\n")


def compute(tag: str, channel: str, priority: str, commit: str, repository: str, token: str) -> tuple[str | None, list[str]]:
    if not REPOSITORY.fullmatch(repository) or not token:
        raise ValueError("release repository credentials are unavailable")
    if not COMMIT.fullmatch(commit):
        raise ValueError("release commit is invalid")
    if tag_commit(tag) != commit:
        raise ValueError("release tag does not identify the checked-out source commit")
    if priority == "critical":
        return tag, [tag]
    inherited = inherited_markers(tag, commit, repository, token)
    marker, fixes = compute_release_state(tag, channel, priority, inherited)
    return marker, prune_fix_frontier(fixes)


def append_github_output(path: Path, marker: str | None, fixes: list[str]) -> None:
    with path.open("a", encoding="utf-8", newline="\n") as output:
        output.write(f"criticalThrough={marker or ''}\n")
        output.write(f"criticalFixes={json.dumps(fixes, separators=(',', ':'))}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--channel", required=True, choices=("stable", "nightly"))
    parser.add_argument("--priority", required=True, choices=("normal", "critical"))
    parser.add_argument("--commit", required=True)
    parser.add_argument("--notes", required=True, type=Path)
    parser.add_argument("--notes-output", required=True, type=Path)
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args(argv)
    try:
        marker, fixes = compute(
            args.tag,
            args.channel,
            args.priority,
            args.commit,
            os.environ.get("GITHUB_REPOSITORY", ""),
            os.environ.get("GH_TOKEN", ""),
        )
        append_marker(args.notes, args.notes_output, marker)
        if args.github_output:
            append_github_output(args.github_output, marker, fixes)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps({"tag": args.tag, "channel": args.channel, "criticalThrough": marker, "criticalFixes": fixes}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
