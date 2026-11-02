#!/usr/bin/env python3
"""Verify retained controller publication provenance without enrolling or activating it.

The expected release is an authority supplied by the independently verified
publication path, never by the evidence bundle being verified. A proof establishes
metadata identity; archive/layer verification, host authorization and coherent
restore activation are separate requirements.
"""

import base64
import binascii
import hashlib
import importlib.util
import json
import os
import re
import selectors
import subprocess
import sys
import time
from pathlib import Path
from typing import NamedTuple


SPEC = importlib.util.spec_from_file_location("orbis_release_check_for_identity", Path(__file__).with_name("orbis-release-check.py"))
assert SPEC and SPEC.loader
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)

METADATA_BYTES = 1024 * 1024
MAX_DESCRIPTORS = 256
MAX_LAYERS = 512
MAX_LAYER_BYTES = 16 * 1024 ** 3
MAX_IMAGE_BYTES = 64 * 1024 ** 3
PROOF_WIRE_BYTES = 4 * 1024 * 1024
PRODUCER_TIMEOUT_SECONDS = 120
PROOF_SCHEMA = "orbis.controller-publication-proof.v1"
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")
SOURCE = "https://github.com/twentylines/orbis"
OCI_INDEX = "application/vnd.oci.image.index.v1+json"
OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
OCI_CONFIG = "application/vnd.oci.image.config.v1+json"
DOCKER_INDEX = "application/vnd.docker.distribution.manifest.list.v2+json"
DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json"
DOCKER_CONFIG = "application/vnd.docker.container.image.v1+json"
LAYER_TYPES = {
    OCI_MANIFEST: {"application/vnd.oci.image.layer.v1.tar", "application/vnd.oci.image.layer.v1.tar+gzip"},
    DOCKER_MANIFEST: {"application/vnd.docker.image.rootfs.diff.tar.gzip"},
}


def fail() -> ValueError:
    return ValueError("Controller publication evidence could not be verified")


def digest(body: bytes) -> str:
    return "sha256:" + hashlib.sha256(body).hexdigest()


def exact(value: object, required: set[str], optional: set[str] = frozenset()) -> bool:
    return type(value) is dict and required <= set(value) <= required | optional


def pairs(items):
    value = {}
    for key, item in items:
        if key in value:
            raise fail()
        value[key] = item
    return value


def unsupported_number(_):
    raise fail()


def metadata(body: bytes, *, byte_limit: int = METADATA_BYTES, string_limit: int = 65536) -> dict:
    if type(body) is not bytes or not 1 <= len(body) <= byte_limit:
        raise fail()
    try:
        value = json.loads(body.decode("utf-8"), object_pairs_hook=pairs,
                           parse_float=unsupported_number, parse_constant=unsupported_number)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise fail() from error
    if type(value) is not dict:
        raise fail()
    pending = [(value, 0)]
    count = 0
    while pending:
        item, depth = pending.pop()
        count += 1
        if depth > 32 or count > 50_000:
            raise fail()
        if type(item) is dict:
            if len(item) > 256 or any(type(key) is not str or len(key) > 1024 for key in item):
                raise fail()
            pending.extend((child, depth + 1) for child in item.values())
        elif type(item) is list:
            if len(item) > 2048:
                raise fail()
            pending.extend((child, depth + 1) for child in item)
        elif type(item) is str:
            if len(item) > string_limit or any(0xD800 <= ord(char) <= 0xDFFF for char in item):
                raise fail()
        elif type(item) is int:
            if not -(2 ** 63) <= item < 2 ** 64:
                raise fail()
        elif item is not None and type(item) is not bool:
            raise fail()
    return value


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def release_identity(expected_release: dict) -> dict:
    """Normalize an already independently verified release; this does not authenticate it."""
    try:
        raw = metadata(canonical(expected_release))
        CHECK.PLAN.validate_manifest(raw)
    except (TypeError, ValueError, RecursionError) as error:
        raise fail() from error
    names = ("schema", "image", "tag", "commit", "digest", "runtipiCompatibility", "installationProtocol")
    return {name: raw[name] for name in names if name in raw}


def platform_identity(value: object, *, selectable: bool) -> dict:
    if not exact(value, {"os", "architecture"}, {"variant"}):
        raise fail()
    if any(type(part) is not str or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", part) for part in value.values()):
        raise fail()
    if selectable and (value["os"] != "linux" or value["architecture"] not in {"amd64", "arm64"}):
        raise fail()
    return dict(value)


def annotations(value: object) -> None:
    if (type(value) is not dict or len(value) > 32
            or any(type(key) is not str or not 1 <= len(key) <= 256
                   or type(item) is not str or len(item) > 4096 for key, item in value.items())
            or len(canonical(value)) > 16384):
        raise fail()


def descriptor(value: object, types: set[str], limit: int, *, with_platform: bool = False) -> dict:
    if not exact(value, {"mediaType", "digest", "size"} | ({"platform"} if with_platform else set()), {"annotations"}):
        raise fail()
    if (type(value["mediaType"]) is not str or value["mediaType"] not in types
            or type(value["digest"]) is not str or not DIGEST.fullmatch(value["digest"])
            or type(value["size"]) is not int or not 1 <= value["size"] <= limit):
        raise fail()
    if "annotations" in value:
        annotations(value["annotations"])
    if with_platform:
        platform_identity(value["platform"], selectable=False)
    return value


def selected_descriptor(index: dict, platform: dict) -> dict:
    if (not exact(index, {"schemaVersion", "mediaType", "manifests"}, {"annotations"})
            or type(index["schemaVersion"]) is not int or index["schemaVersion"] != 2
            or type(index["mediaType"]) is not str or index["mediaType"] not in {OCI_INDEX, DOCKER_INDEX}
            or type(index["manifests"]) is not list or not 1 <= len(index["manifests"]) <= MAX_DESCRIPTORS):
        raise fail()
    if "annotations" in index:
        annotations(index["annotations"])
    kind = OCI_MANIFEST if index["mediaType"] == OCI_INDEX else DOCKER_MANIFEST
    matches = []
    for raw in index["manifests"]:
        item = descriptor(raw, {kind}, METADATA_BYTES, with_platform=True)
        if item["platform"] == platform:
            if item.get("annotations", {}).get("vnd.docker.reference.type") == "attestation-manifest":
                raise fail()
            matches.append(item)
    if len(matches) != 1:
        raise fail()
    return matches[0]


def bound_metadata(body: bytes, expected: dict) -> dict:
    if type(body) is not bytes or len(body) != expected["size"] or digest(body) != expected["digest"]:
        raise fail()
    return metadata(body)


class VerifiedPublishedGraph(NamedTuple):
    publication_bytes: bytes
    platform_bytes: bytes
    index_bytes: bytes
    manifest_bytes: bytes
    config_bytes: bytes
    manifest_digest: str
    config_digest: str
    rootfs_diff_ids: tuple[str, ...]

    def proof(self) -> dict:
        return {"schema": PROOF_SCHEMA, "publication": json.loads(self.publication_bytes),
                "platform": json.loads(self.platform_bytes),
                **{name: base64.b64encode(value).decode("ascii") for name, value in (
                    ("index", self.index_bytes), ("manifest", self.manifest_bytes), ("config", self.config_bytes))}}

    def creation_reference(self, archive_kind: str) -> str:
        """Derive a reference only; neither this result nor its type authorizes execution."""
        if archive_kind == "oci":
            return self.manifest_digest
        if archive_kind == "docker":
            return self.config_digest
        raise fail()

    def summary(self) -> dict:
        publication = json.loads(self.publication_bytes)
        return {"publication": publication, "publishedReference": f"{publication['image']}@{publication['digest']}",
                "platform": json.loads(self.platform_bytes), "platformManifestDigest": self.manifest_digest,
                "configDigest": self.config_digest, "rootfsDiffIds": list(self.rootfs_diff_ids)}


def verify_published_graph(expected_release: dict, *, platform: dict, index_bytes: bytes,
                           manifest_bytes: bytes, config_bytes: bytes) -> VerifiedPublishedGraph:
    """Expected release must come from independent publication verification, outside this evidence."""
    publication = release_identity(expected_release)
    selected_platform = platform_identity(platform, selectable=True)
    index = metadata(index_bytes)
    if digest(index_bytes) != publication["digest"]:
        raise fail()
    selected = selected_descriptor(index, selected_platform)
    manifest = bound_metadata(manifest_bytes, selected)
    if (not exact(manifest, {"schemaVersion", "mediaType", "config", "layers"}, {"annotations"})
            or type(manifest["schemaVersion"]) is not int or manifest["schemaVersion"] != 2
            or manifest["mediaType"] != selected["mediaType"]
            or type(manifest["layers"]) is not list or not 1 <= len(manifest["layers"]) <= MAX_LAYERS):
        raise fail()
    if "annotations" in manifest:
        annotations(manifest["annotations"])
    config_type = OCI_CONFIG if selected["mediaType"] == OCI_MANIFEST else DOCKER_CONFIG
    config_descriptor = descriptor(manifest["config"], {config_type}, METADATA_BYTES)
    total = 0
    for item in manifest["layers"]:
        total += descriptor(item, LAYER_TYPES[selected["mediaType"]], MAX_LAYER_BYTES)["size"]
        if total > MAX_IMAGE_BYTES:
            raise fail()
    config = bound_metadata(config_bytes, config_descriptor)
    if (not exact(config, {"architecture", "os", "config", "rootfs"}, {"variant", "created", "author", "history"})
            or type(config["config"]) is not dict
            or not exact(config["rootfs"], {"type", "diff_ids"})
            or config["rootfs"]["type"] != "layers"
            or type(config["rootfs"]["diff_ids"]) is not list
            or len(config["rootfs"]["diff_ids"]) != len(manifest["layers"])
            or any(type(item) is not str or not DIGEST.fullmatch(item) for item in config["rootfs"]["diff_ids"])):
        raise fail()
    actual_platform = {key: config[key] for key in ("os", "architecture", "variant") if key in config}
    if platform_identity(actual_platform, selectable=True) != selected_platform:
        raise fail()
    labels = config["config"].get("Labels")
    if (type(labels) is not dict or len(labels) > 128
            or any(type(key) is not str or len(key) > 256 or type(value) is not str or len(value) > 4096
                   for key, value in labels.items())
            or labels.get("org.opencontainers.image.source") != SOURCE
            or labels.get("org.opencontainers.image.version") != publication["tag"]
            or labels.get("org.opencontainers.image.revision") != publication["commit"]
            or ("installationProtocol" in publication
                and labels.get("io.orbis.installation-protocol") != publication["installationProtocol"])):
        raise fail()
    return VerifiedPublishedGraph(canonical(publication), canonical(selected_platform), index_bytes, manifest_bytes,
                                  config_bytes, selected["digest"], config_descriptor["digest"], tuple(config["rootfs"]["diff_ids"]))


def verify_publication_proof(expected_release: dict, proof: dict) -> VerifiedPublishedGraph:
    """Recheck portable evidence against separately authenticated publication authority."""
    if (not exact(proof, {"schema", "publication", "platform", "index", "manifest", "config"})
            or proof["schema"] != PROOF_SCHEMA or proof["publication"] != release_identity(expected_release)):
        raise fail()
    blobs = {}
    for name in ("index", "manifest", "config"):
        value = proof[name]
        if type(value) is not str or not 1 <= len(value) <= 4 * ((METADATA_BYTES + 2) // 3):
            raise fail()
        try:
            blobs[name + "_bytes"] = base64.b64decode(value, validate=True)
        except (ValueError, binascii.Error) as error:
            raise fail() from error
        if base64.b64encode(blobs[name + "_bytes"]).decode("ascii") != value:
            raise fail()
    return verify_published_graph(expected_release, platform=proof["platform"], **blobs)


def produce_publication_proof(tag: str, platform: dict) -> VerifiedPublishedGraph:
    """Read-only online producer. Reuses the authoritative GitHub/GHCR publication check."""
    platform = platform_identity(platform, selectable=True)
    published = CHECK.check(tag)
    reference = published["image"]
    prefix = CHECK.PLAN.IMAGE + "@"
    if type(reference) is not str or not reference.startswith(prefix):
        raise fail()
    release = {"schema": "orbis.release.v1", "image": CHECK.PLAN.IMAGE, "tag": published["tag"],
               "commit": published["commit"], "digest": reference[len(prefix):],
               "runtipiCompatibility": published["runtipiCompatibility"]}
    if published.get("installationProtocol") is not None:
        release["installationProtocol"] = published["installationProtocol"]
    release = release_identity(release)
    token = CHECK.read_json(f"{CHECK.GHCR}/token?scope=repository:twentylines/orbis:pull&service=ghcr.io", 16 * 1024)
    if (type(token) is not dict or type(token.get("token")) is not str or not 1 <= len(token["token"]) <= 16384
            or any(ord(char) < 32 or ord(char) > 126 for char in token["token"])):
        raise fail()
    headers = {"Authorization": "Bearer " + token["token"]}
    index_bytes, response_headers = CHECK.read_url(
        f"{CHECK.GHCR}/v2/twentylines/orbis/manifests/{release['digest']}", METADATA_BYTES,
        {**headers, "Accept": ", ".join(sorted(CHECK.INDEX_TYPES))})
    header_digest = next((value for name, value in response_headers.items() if name.lower() == "docker-content-digest"), None)
    if header_digest != release["digest"] or digest(index_bytes) != release["digest"]:
        raise fail()
    selected = selected_descriptor(metadata(index_bytes), platform)
    manifest_bytes, _ = CHECK.read_url(
        f"{CHECK.GHCR}/v2/twentylines/orbis/manifests/{selected['digest']}", selected["size"],
        {**headers, "Accept": selected["mediaType"]})
    manifest = bound_metadata(manifest_bytes, selected)
    config_type = OCI_CONFIG if selected["mediaType"] == OCI_MANIFEST else DOCKER_CONFIG
    config = descriptor(manifest.get("config"), {config_type}, METADATA_BYTES)
    config_bytes, _ = CHECK.read_url(f"{CHECK.GHCR}/v2/twentylines/orbis/blobs/{config['digest']}", config["size"], headers)
    return verify_published_graph(release, platform=platform, index_bytes=index_bytes,
                                  manifest_bytes=manifest_bytes, config_bytes=config_bytes)


def produce_bounded_publication(tag: str, platform: dict, cancelled=None, *, timeout_seconds=PRODUCER_TIMEOUT_SECONDS) -> dict:
    """Isolate network reads behind an absolute deadline and bounded output pipes."""
    if (type(tag) is not str or not CHECK.PLAN.POLICY.is_published_release_tag(tag)
            or type(timeout_seconds) not in {int, float} or not 0 < timeout_seconds <= PRODUCER_TIMEOUT_SECONDS):
        raise fail()
    request = canonical({"tag": tag, "platform": platform_identity(platform, selectable=True)})
    if len(request) > 1024 or (cancelled is not None and cancelled()):
        raise fail()
    deadline = time.monotonic() + timeout_seconds
    process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--publication-proof-worker"],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
    output = bytearray()
    stderr_bytes = 0
    try:
        process.stdin.write(request)
        process.stdin.close()
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, "stdout")
            selector.register(process.stderr, selectors.EVENT_READ, "stderr")
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0 or (cancelled is not None and cancelled()):
                    raise fail()
                for key, _ in selector.select(min(remaining, 0.1)):
                    block = os.read(key.fileobj.fileno(), 65536)
                    if not block:
                        selector.unregister(key.fileobj)
                    elif key.data == "stdout":
                        output.extend(block)
                        if len(output) > PROOF_WIRE_BYTES:
                            raise fail()
                    else:
                        stderr_bytes += len(block)
                        if stderr_bytes > 8192:
                            raise fail()
        remaining = deadline - time.monotonic()
        if remaining <= 0 or process.wait(timeout=remaining) != 0 or (cancelled is not None and cancelled()):
            raise fail()
        return metadata(bytes(output), byte_limit=PROOF_WIRE_BYTES, string_limit=4 * ((METADATA_BYTES + 2) // 3))
    except (OSError, subprocess.SubprocessError) as error:
        raise fail() from error
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        for stream in (process.stdin, process.stdout, process.stderr):
            stream.close()


def publication_worker(source, destination) -> None:
    request = source.read(1025)
    value = metadata(request)
    if len(request) > 1024 or not exact(value, {"tag", "platform"}):
        raise fail()
    proof = produce_publication_proof(value["tag"], value["platform"]).proof()
    body = canonical(proof)
    if len(body) > PROOF_WIRE_BYTES:
        raise fail()
    destination.write(body)
    destination.flush()


if __name__ == "__main__":
    try:
        if sys.argv[1:] != ["--publication-proof-worker"]:
            raise fail()
        publication_worker(sys.stdin.buffer, sys.stdout.buffer)
    except Exception:
        sys.stderr.write("Controller publication preparation is unavailable.\n")
        sys.exit(2)
