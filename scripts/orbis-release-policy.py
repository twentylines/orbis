#!/usr/bin/env python3
"""Shared Orbis release-channel and downgrade policy."""

import re


MAX_SAFE_INTEGER = 9_007_199_254_740_991
VERSION = re.compile(r"^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(beta|rc)\.(0|[1-9][0-9]*))?$")
PUBLISHED_TAG = re.compile(r"^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:beta|rc)\.(?:0|[1-9][0-9]*))?$")
PRERELEASE_RANK = {"beta": 0, "rc": 1, None: 2}


def parse_version(value: object) -> dict[str, object] | None:
    if not isinstance(value, str) or len(value) > 80:
        return None
    match = VERSION.fullmatch(value)
    if not match:
        return None
    numbers = [int(match.group(index)) for index in (1, 2, 3)]
    iteration = int(match.group(5)) if match.group(5) is not None else None
    if any(number > MAX_SAFE_INTEGER for number in numbers) or (iteration is not None and iteration > MAX_SAFE_INTEGER):
        return None
    return {
        "base": ".".join(str(number) for number in numbers),
        "numbers": numbers,
        "prerelease": match.group(4),
        "iteration": iteration,
    }


def is_published_release_tag(tag: object) -> bool:
    return isinstance(tag, str) and len(tag) <= 80 and PUBLISHED_TAG.fullmatch(tag) is not None and parse_version(tag) is not None


def is_stable_release_tag(tag: object) -> bool:
    parsed = parse_version(tag) if is_published_release_tag(tag) else None
    return parsed is not None and parsed["prerelease"] is None


def release_allowed_on_channel(tag: object, channel: object) -> bool:
    if channel not in ("stable", "nightly") or not is_published_release_tag(tag):
        return False
    return channel == "nightly" or is_stable_release_tag(tag)


def version_order(first: object, second: object) -> int | None:
    a = parse_version(first)
    b = parse_version(second)
    if a is None or b is None:
        return None
    for left, right in zip(a["numbers"], b["numbers"]):
        if left != right:
            return -1 if left < right else 1
    a_stage = a["prerelease"]
    b_stage = b["prerelease"]
    stage_delta = PRERELEASE_RANK[a_stage] - PRERELEASE_RANK[b_stage]
    if stage_delta:
        return -1 if stage_delta < 0 else 1
    a_iteration = a["iteration"] or 0
    b_iteration = b["iteration"] or 0
    return (a_iteration > b_iteration) - (a_iteration < b_iteration)


def downgrade_allowed_on_channel(target: object, installed: object, channel: object) -> bool:
    if not release_allowed_on_channel(target, channel):
        return False
    current = parse_version(installed)
    candidate = parse_version(target)
    if current is None or candidate is None or version_order(target, installed) != -1:
        return False
    return candidate["prerelease"] is None or (channel == "nightly" and candidate["base"] == current["base"])
