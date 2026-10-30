#!/usr/bin/env python3
"""Create safe GitHub Actions metadata for a published Orbis release."""

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path


POLICY_PATH = Path(__file__).with_name("orbis-release-policy.py")
SPEC = importlib.util.spec_from_file_location("orbis_release_policy", POLICY_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("release policy helper is unavailable")
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)

MAX_NOTES_BYTES = 64 * 1024
HEADER = re.compile(
    r"^[\t ]*<!--[\t ]*(orbis-release-kind|orbis-update-priority):[\t ]*"
    r"(feature|maintenance|critical|normal)[\t ]*-->[\t ]*\r?\n*"
)


def parse_release_notes(notes: str) -> tuple[str, str, str]:
    """Return body, kind and priority from up to two recognized leading headers."""
    body = notes.removeprefix("\ufeff")
    kind = "maintenance"
    priority = "normal"
    seen: set[str] = set()
    for _ in range(2):
        match = HEADER.match(body)
        if not match:
            break
        field, value = match.groups()
        if field in seen:
            break
        if field == "orbis-release-kind" and value not in {"feature", "maintenance"}:
            break
        if field == "orbis-update-priority" and value not in {"critical", "normal"}:
            break
        seen.add(field)
        if field == "orbis-release-kind":
            kind = value
        else:
            priority = value
        body = body[match.end():]
    return body, kind, priority


def release_metadata(tag: str, notes_path: Path) -> dict[str, object]:
    if not POLICY.is_published_release_tag(tag):
        raise ValueError("tag must be a strict published Orbis release tag")
    if notes_path.name != f"{tag}.md":
        raise ValueError("release notes filename must match the tag")
    try:
        raw = notes_path.read_bytes()
    except OSError as error:
        raise ValueError("release notes file cannot be read") from error
    if len(raw) > MAX_NOTES_BYTES:
        raise ValueError("release notes exceed 64 KiB")
    try:
        notes = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("release notes must be UTF-8") from error

    parsed = POLICY.parse_version(tag)
    if parsed is None:
        raise ValueError("tag must be a strict published Orbis release tag")
    body, kind, priority = parse_release_notes(notes)
    if not body.strip():
        raise ValueError("release notes must contain a changelog")
    prerelease = parsed["prerelease"] is not None
    suffix = f" {parsed['prerelease']} {parsed['iteration']}" if prerelease else ""
    base = parsed["base"]
    if prerelease and base.endswith(".0"):
        base = base[:-2]
    return {
        "tag": tag,
        "displayVersion": f"{base}{suffix}",
        "channel": "nightly" if prerelease else "stable",
        "prerelease": prerelease,
        "priority": priority,
        "kind": kind,
    }


def append_github_output(path: Path, metadata: dict[str, object]) -> None:
    fields = ("tag", "displayVersion", "channel", "prerelease", "priority", "kind")
    with path.open("a", encoding="utf-8", newline="\n") as output:
        for field in fields:
            value = str(metadata[field]).lower() if isinstance(metadata[field], bool) else str(metadata[field])
            output.write(f"{field}={value}\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--notes", required=True, type=Path)
    parser.add_argument("--github-output", type=Path)
    args = parser.parse_args(argv)
    try:
        metadata = release_metadata(args.tag, args.notes)
        if args.github_output:
            append_github_output(args.github_output, metadata)
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(metadata, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
