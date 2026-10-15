#!/usr/bin/env python3
"""Verify one published Orbis release and its GHCR image without changing the host."""

import argparse
import hashlib
import importlib.util
import json
import sys
from urllib.parse import quote
from urllib.request import Request, urlopen

from pathlib import Path


SPEC = importlib.util.spec_from_file_location("orbis_release_plan", Path(__file__).with_name("orbis-release-plan.py"))
assert SPEC and SPEC.loader
PLAN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PLAN)

GITHUB_API = "https://api.github.com/repos/twentylines/orbis"
GHCR = "https://ghcr.io"
INDEX_TYPES = {"application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"}
USER_AGENT = "Orbis-release-check/1"


def read_url(url: str, limit: int, headers: dict[str, str] | None = None) -> tuple[bytes, dict[str, str]]:
    request = Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urlopen(request, timeout=12) as response:
        body = response.read(limit + 1)
        if len(body) > limit:
            raise ValueError("release response exceeded its size limit")
        return body, dict(response.headers)


def read_json(url: str, limit: int, headers: dict[str, str] | None = None) -> object:
    body, _ = read_url(url, limit, headers)
    return json.loads(body)


def release_asset(release: object, tag: str) -> str:
    if not isinstance(release, dict) or release.get("tag_name") != tag or release.get("draft") is not False:
        raise ValueError("GitHub release tag or publication state did not match")
    assets = release.get("assets")
    if not isinstance(assets, list):
        raise ValueError("GitHub release has no asset list")
    expected = f"https://github.com/twentylines/orbis/releases/download/{quote(tag)}/release-manifest.json"
    matches = [asset for asset in assets if isinstance(asset, dict) and asset.get("name") == "release-manifest.json"]
    if len(matches) != 1 or matches[0].get("browser_download_url") != expected:
        raise ValueError("GitHub release has no matching Orbis manifest asset")
    return expected


def tag_commit(tag_ref: object, tag_object: object | None = None) -> str:
    if not isinstance(tag_ref, dict) or not isinstance(tag_ref.get("object"), dict):
        raise ValueError("GitHub tag reference is invalid")
    target = tag_ref["object"]
    if target.get("type") == "tag":
        if not isinstance(tag_object, dict) or not isinstance(tag_object.get("object"), dict):
            raise ValueError("GitHub annotated tag is invalid")
        target = tag_object["object"]
    if target.get("type") != "commit" or not isinstance(target.get("sha"), str) or not PLAN.COMMIT.fullmatch(target["sha"]):
        raise ValueError("GitHub tag does not resolve to a commit")
    return target["sha"]


def verify_index(body: bytes, header_digest: str | None, expected_digest: str) -> list[str]:
    actual = "sha256:" + hashlib.sha256(body).hexdigest()
    if actual != expected_digest or header_digest != expected_digest:
        raise ValueError("GHCR image index digest did not match the release manifest")
    index = json.loads(body)
    if not isinstance(index, dict) or index.get("mediaType") not in INDEX_TYPES or not isinstance(index.get("manifests"), list):
        raise ValueError("GHCR did not return a multi-platform image index")
    platforms = sorted({
        f"{platform['os']}/{platform['architecture']}"
        for item in index["manifests"]
        if isinstance(item, dict) and isinstance((platform := item.get("platform")), dict)
        and platform.get("os") == "linux" and isinstance(platform.get("architecture"), str)
    })
    if not {"linux/amd64", "linux/arm64"}.issubset(platforms):
        raise ValueError("GHCR image index is missing a supported Linux platform")
    return platforms


def check(tag: str) -> dict[str, object]:
    if not PLAN.TAG.fullmatch(tag):
        raise ValueError("release tag is invalid")
    release = read_json(f"{GITHUB_API}/releases/tags/{quote(tag)}", 512 * 1024, {"Accept": "application/vnd.github+json"})
    asset_url = release_asset(release, tag)
    manifest = PLAN.validate_manifest(read_json(asset_url, 16 * 1024))
    if manifest["tag"] != tag:
        raise ValueError("release manifest tag did not match GitHub")

    ref = read_json(f"{GITHUB_API}/git/ref/tags/{quote(tag)}", 16 * 1024, {"Accept": "application/vnd.github+json"})
    tag_object = None
    if isinstance(ref, dict) and isinstance(ref.get("object"), dict) and ref["object"].get("type") == "tag":
        tag_sha = ref["object"].get("sha")
        if not isinstance(tag_sha, str) or not PLAN.COMMIT.fullmatch(tag_sha):
            raise ValueError("GitHub annotated tag identifier is invalid")
        tag_object = read_json(f"{GITHUB_API}/git/tags/{tag_sha}", 16 * 1024, {"Accept": "application/vnd.github+json"})
    if tag_commit(ref, tag_object) != manifest["commit"]:
        raise ValueError("release manifest commit did not match the Git tag")

    token_response = read_json(f"{GHCR}/token?scope=repository:twentylines/orbis:pull&service=ghcr.io", 16 * 1024)
    if not isinstance(token_response, dict) or not isinstance(token_response.get("token"), str):
        raise ValueError("GHCR did not provide an anonymous pull token")
    body, headers = read_url(
        f"{GHCR}/v2/twentylines/orbis/manifests/{manifest['digest']}",
        1024 * 1024,
        {"Accept": ", ".join(sorted(INDEX_TYPES)), "Authorization": f"Bearer {token_response['token']}"},
    )
    header_digest = next((value for name, value in headers.items() if name.lower() == "docker-content-digest"), None)
    platforms = verify_index(body, header_digest, manifest["digest"])
    return {
        "tag": tag,
        "commit": manifest["commit"],
        "image": f"{manifest['image']}@{manifest['digest']}",
        "runtipiCompatibility": manifest["runtipiCompatibility"],
        "platforms": platforms,
        "publishedAt": release.get("published_at") if isinstance(release, dict) else None,
        "releaseUrl": release.get("html_url") if isinstance(release, dict) else None,
        "notes": release.get("body") if isinstance(release, dict) else None,
        "readOnly": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag", help="published Orbis GitHub release tag")
    args = parser.parse_args()
    try:
        print(json.dumps(check(args.tag), indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as error:
        print(f"Orbis release check failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
