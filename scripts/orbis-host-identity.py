#!/usr/bin/env python3
"""Pure identity comparison, with no filesystem, Docker or enrollment writes.

Retained authority MUST be supplied by a separate root-authenticated immutable
point reader, never copied from the candidate descriptor or an HTTP request.
This module compares that authority; it does not authenticate it or authorize
activation, adoption, restore, or a lifecycle mutation.
"""

import importlib.util
import json
import re
from pathlib import Path
from typing import NamedTuple

SPEC = importlib.util.spec_from_file_location("orbis_publication_for_host_identity", Path(__file__).with_name("orbis-controller-identity.py"))
assert SPEC and SPEC.loader
PUBLICATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PUBLICATION)
RETAINED_SCHEMA = "orbis.host.retained-controller.v1"
AUTHORITY_SCHEMA = "orbis.host.retained-authority.v1"
HEX = re.compile(r"[a-f0-9]{64}")
FILES = {"docker-compose.yml", ".env", "user-config/tipi-compose.yml", "orbis-compose.yml"}


def fail():
    return ValueError("Host controller identity could not be verified")


def hashed(value):
    return type(value) is str and PUBLICATION.DIGEST.fullmatch(value) is not None


def files(value):
    if (type(value) is not dict or not FILES <= set(value) <= FILES | {"orbis-host-compose.yml"}
            or any(item is not None and (type(item) is not str or not HEX.fullmatch(item)) for item in value.values())
            or any(value[name] is None for name in ("docker-compose.yml", ".env", "orbis-compose.yml"))):
        raise fail()
    return value


def binding(root, context):
    if (type(root) is not str or not root.startswith("/") or "\x00" in root or len(root) > 4096
            or str(Path(root)) != root or any(part in {".", ".."} for part in root.split("/"))
            or type(context) is not str or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", context)):
        raise fail()


class ResolvedHostIdentity(NamedTuple):
    mode: str
    publication_bytes: bytes
    controller_bytes: bytes

    def publication(self):
        return json.loads(self.publication_bytes)

    def controller(self):
        return json.loads(self.controller_bytes)


def resolve_host_identity(enrollment_bytes, *, root, context, current_files, expected_release,
                          observation, retained_authority=None, proof=None):
    """Resolve v1 alias or retained identity using separately supplied authority.

    Observation is a minimal normalized local inspection, not caller identity.
    The caller must collect it from the selected Docker context and container.
    Missing observations fail closed. Returned data grants no execution rights.
    """
    binding(root, context)
    current_files = files(current_files)
    saved = PUBLICATION.metadata(enrollment_bytes)
    release = PUBLICATION.release_identity(expected_release)
    published = release["image"] + "@" + release["digest"]
    if saved.get("schema") == "orbis.host.v1":
        if (not PUBLICATION.exact(saved, {"schema", "root", "dockerContext", "tag", "digest", "files"})
                or saved["root"] != root or saved["dockerContext"] != context
                or files(saved["files"]) != current_files
                or saved["tag"] != release["tag"] or saved["digest"] != release["digest"]
                or retained_authority is not None or proof is not None
                or not PUBLICATION.exact(observation, {"creationReference", "repoDigests", "labels"})
                or observation["creationReference"] != published
                or type(observation["repoDigests"]) is not list
                or any(type(item) is not str for item in observation["repoDigests"])
                or published not in observation["repoDigests"]):
            raise fail()
        labels = observation["labels"]
        if (type(labels) is not dict or labels.get("org.opencontainers.image.source") != PUBLICATION.SOURCE
                or labels.get("org.opencontainers.image.version") != release["tag"]
                or labels.get("org.opencontainers.image.revision") != release["commit"]
                or ("installationProtocol" in release
                    and labels.get("io.orbis.installation-protocol") != release["installationProtocol"])):
            raise fail()
        return ResolvedHostIdentity("published", PUBLICATION.canonical(release),
                                    PUBLICATION.canonical({"publishedReference": published, "creationReference": published}))
    required = {"schema", "root", "dockerContext", "files", "pointId", "configurationDigest", "archiveRootId",
                "archiveKind", "proofDigest", "publication", "platform", "platformManifestDigest", "configDigest",
                "sourceImageId", "creationReference"}
    authority_keys = {"schema", "root", "dockerContext", "descriptorDigest", "pointId", "configurationDigest",
                      "archiveRootId", "proofDigest", "publication"}
    if (not PUBLICATION.exact(saved, required) or saved["schema"] != RETAINED_SCHEMA
            or not PUBLICATION.exact(retained_authority, authority_keys)
            or retained_authority["schema"] != AUTHORITY_SCHEMA
            or not hashed(retained_authority["descriptorDigest"])
            or PUBLICATION.digest(enrollment_bytes) != retained_authority["descriptorDigest"]
            or saved["root"] != root or saved["dockerContext"] != context
            or files(saved["files"]) != current_files
            or retained_authority["root"] != root or retained_authority["dockerContext"] != context
            or saved["publication"] != release or retained_authority["publication"] != release):
        raise fail()
    for key in ("pointId", "configurationDigest", "archiveRootId", "proofDigest"):
        if not hashed(saved[key]) or saved[key] != retained_authority[key]:
            raise fail()
    if not hashed(saved["sourceImageId"]):
        raise fail()
    if type(proof) is not bytes or PUBLICATION.digest(proof) != saved["proofDigest"]:
        raise fail()
    graph = PUBLICATION.verify_publication_proof(release, PUBLICATION.metadata(
        proof, byte_limit=PUBLICATION.PROOF_WIRE_BYTES, string_limit=4 * ((PUBLICATION.METADATA_BYTES + 2) // 3)))
    creation = graph.creation_reference(saved["archiveKind"])
    platform = json.loads(graph.platform_bytes)
    if (saved["platform"] != platform or saved["platformManifestDigest"] != graph.manifest_digest
            or saved["configDigest"] != graph.config_digest or saved["creationReference"] != creation
            or not PUBLICATION.exact(observation, {"creationReference", "imageId", "configDigest", "platform", "rootfsDiffIds"})
            or observation["creationReference"] != creation or observation["imageId"] != creation
            or observation["configDigest"] != graph.config_digest or observation["platform"] != platform
            or observation["rootfsDiffIds"] != list(graph.rootfs_diff_ids)):
        raise fail()
    return ResolvedHostIdentity("retained", graph.publication_bytes, PUBLICATION.canonical({
        "publishedReference": published, "platform": platform, "platformManifestDigest": graph.manifest_digest,
        "configDigest": graph.config_digest, "sourceImageId": saved["sourceImageId"], "creationReference": creation,
        "pointId": saved["pointId"], "configurationDigest": saved["configurationDigest"],
        "archiveRootId": saved["archiveRootId"], "descriptorDigest": retained_authority["descriptorDigest"],
        "archiveKind": saved["archiveKind"], "proofDigest": saved["proofDigest"]}))
