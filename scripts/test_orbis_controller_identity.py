import copy
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("orbis_controller_identity", Path(__file__).with_name("orbis-controller-identity.py"))
assert SPEC and SPEC.loader
IDENTITY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IDENTITY)

PLATFORM = {"os": "linux", "architecture": "arm64"}
TAG = "v0.5.0-beta.3"
COMMIT = "a" * 40
PROTOCOL = "orbis.installation-state.v1"


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def sha(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def fixture(*, config_change=None, manifest_change=None, index_change=None, docker=False):
    config = {"architecture": "arm64", "os": "linux", "config": {"Labels": {
        "org.opencontainers.image.source": IDENTITY.SOURCE,
        "org.opencontainers.image.version": TAG,
        "org.opencontainers.image.revision": COMMIT,
        "io.orbis.installation-protocol": PROTOCOL,
    }}, "rootfs": {"type": "layers", "diff_ids": ["sha256:" + "1" * 64, "sha256:" + "2" * 64]}}
    if config_change:
        config_change(config)
    config_bytes = encode(config)
    manifest = {"schemaVersion": 2, "mediaType": IDENTITY.DOCKER_MANIFEST if docker else IDENTITY.OCI_MANIFEST,
                "config": {"mediaType": IDENTITY.DOCKER_CONFIG if docker else IDENTITY.OCI_CONFIG,
                           "digest": sha(config_bytes), "size": len(config_bytes)},
                "layers": [{"mediaType": "application/vnd.docker.image.rootfs.diff.tar.gzip" if docker
                            else "application/vnd.oci.image.layer.v1.tar+gzip", "digest": "sha256:" + str(index) * 64,
                            "size": 128} for index in (3, 4)]}
    if manifest_change:
        manifest_change(manifest)
    manifest_bytes = encode(manifest)
    index = {"schemaVersion": 2, "mediaType": IDENTITY.DOCKER_INDEX if docker else IDENTITY.OCI_INDEX,
             "manifests": [{"mediaType": manifest["mediaType"], "digest": sha(manifest_bytes), "size": len(manifest_bytes),
                            "platform": dict(PLATFORM)}]}
    if index_change:
        index_change(index)
    index_bytes = encode(index)
    release = {"schema": "orbis.release.v1", "image": IDENTITY.CHECK.PLAN.IMAGE, "tag": TAG, "commit": COMMIT,
               "digest": sha(index_bytes), "runtipiCompatibility": "4.10.1", "installationProtocol": PROTOCOL}
    return release, {"platform": dict(PLATFORM), "index_bytes": index_bytes, "manifest_bytes": manifest_bytes,
                     "config_bytes": config_bytes}


class ControllerPublicationIdentityTests(unittest.TestCase):
    def verify(self, **changes):
        release, blobs = fixture(**changes)
        return IDENTITY.verify_published_graph(release, **blobs)

    def rejected(self, **changes):
        with self.assertRaisesRegex(ValueError, "publication evidence"):
            self.verify(**changes)

    def test_exact_graph_and_distinct_creation_references(self):
        release, blobs = fixture()
        verified = IDENTITY.verify_published_graph(release, **blobs)
        self.assertEqual(verified.creation_reference("oci"), sha(blobs["manifest_bytes"]))
        self.assertEqual(verified.creation_reference("docker"), sha(blobs["config_bytes"]))
        self.assertNotEqual(verified.creation_reference("oci"), release["digest"])
        self.assertNotEqual(verified.creation_reference("oci"), verified.creation_reference("docker"))
        self.assertEqual(verified.rootfs_diff_ids, ("sha256:" + "1" * 64, "sha256:" + "2" * 64))
        summary = verified.summary()
        self.assertEqual(summary["publishedReference"], release["image"] + "@" + release["digest"])
        self.assertNotIn("sourceImageId", summary)
        with self.assertRaises(ValueError):
            verified.creation_reference("sha256:" + "0" * 64)

    def test_docker_v2_publication_supports_classic_config_creation(self):
        verified = self.verify(docker=True)
        self.assertEqual(verified.creation_reference("docker"), sha(verified.config_bytes))

    def test_round_trip_requires_external_publication_authority(self):
        release, blobs = fixture()
        verified = IDENTITY.verify_published_graph(release, **blobs)
        proof = verified.proof()
        self.assertEqual(IDENTITY.verify_publication_proof(release, proof), verified)
        forged_release, forged_blobs = fixture(config_change=lambda c: c["config"].update({"Cmd": ["changed"]}))
        forged = IDENTITY.verify_published_graph(forged_release, **forged_blobs).proof()
        with self.assertRaises(ValueError):
            IDENTITY.verify_publication_proof(release, forged)
        forged["publication"] = proof["publication"]
        with self.assertRaises(ValueError):
            IDENTITY.verify_publication_proof(release, forged)

    def test_evidence_never_contains_authority_or_activation_fields(self):
        release, blobs = fixture()
        proof = IDENTITY.verify_published_graph(release, **blobs).proof()
        for extra in ("verified", "enrollment", "imageId", "compose", "path", "restoreReady"):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                IDENTITY.verify_publication_proof(release, {**proof, extra: True})

    def test_all_blob_bytes_are_bound_without_reserializing(self):
        for key in ("index_bytes", "manifest_bytes", "config_bytes"):
            release, blobs = fixture()
            blobs[key] += b" "
            with self.subTest(key=key), self.assertRaises(ValueError):
                IDENTITY.verify_published_graph(release, **blobs)

    def test_index_digest_comes_from_independent_release(self):
        release, blobs = fixture()
        release["digest"] = "sha256:" + "0" * 64
        with self.assertRaises(ValueError):
            IDENTITY.verify_published_graph(release, **blobs)

    def test_platform_manifest_size_and_digest_are_bound(self):
        for change in (lambda i: i["manifests"][0].update(size=1),
                       lambda i: i["manifests"][0].update(digest="sha256:" + "0" * 64)):
            self.rejected(index_change=change)

    def test_config_size_and_digest_are_bound(self):
        for change in (lambda m: m["config"].update(size=1),
                       lambda m: m["config"].update(digest="sha256:" + "0" * 64)):
            self.rejected(manifest_change=change)

    def test_duplicate_matching_platform_is_ambiguous_even_for_identical_digest(self):
        self.rejected(index_change=lambda i: i["manifests"].append(copy.deepcopy(i["manifests"][0])))

    def test_platform_request_is_exact_and_supported(self):
        for platform in ({"os": "linux", "architecture": "amd64"}, {**PLATFORM, "variant": "v8"},
                         {**PLATFORM, "variant": ""}, {**PLATFORM, "features": []},
                         {"os": "windows", "architecture": "arm64"}, {"os": "linux", "architecture": []}):
            release, blobs = fixture()
            blobs["platform"] = platform
            with self.subTest(platform=platform), self.assertRaises(ValueError):
                IDENTITY.verify_published_graph(release, **blobs)

    def test_config_platform_matches_descriptor_including_variant(self):
        for change in (lambda c: c.update(architecture="amd64"), lambda c: c.update(os="windows"),
                       lambda c: c.update(variant="v8")):
            self.rejected(config_change=change)

    def test_valid_variant_is_preserved(self):
        release, blobs = fixture(config_change=lambda c: c.update(variant="v8"),
                                 index_change=lambda i: i["manifests"][0]["platform"].update(variant="v8"))
        blobs["platform"]["variant"] = "v8"
        self.assertEqual(IDENTITY.verify_published_graph(release, **blobs).summary()["platform"]["variant"], "v8")

    def test_release_labels_match_independent_release(self):
        for key in ("org.opencontainers.image.source", "org.opencontainers.image.version", "org.opencontainers.image.revision",
                    "io.orbis.installation-protocol"):
            with self.subTest(label=key):
                self.rejected(config_change=lambda c: c["config"]["Labels"].update({key: "changed"}))
                self.rejected(config_change=lambda c: c["config"]["Labels"].pop(key))

    def test_label_types_and_bounds(self):
        for labels in (None, [], {"label": True}, {"label": "x" * 4097}, {str(i): "x" for i in range(129)}):
            with self.subTest(case=type(labels).__name__):
                self.rejected(config_change=lambda c: c["config"].update(Labels=labels))

    def test_rootfs_structure_count_and_digest_format(self):
        for rootfs in ({"type": "other", "diff_ids": []}, {"type": "layers", "diff_ids": ["sha256:" + "1" * 64]},
                       {"type": "layers", "diff_ids": ["bad", "sha256:" + "2" * 64]},
                       {"type": "layers", "diff_ids": [True, "sha256:" + "2" * 64]},
                       {"type": "layers", "diff_ids": [], "extra": "value"}, None):
            with self.subTest(rootfs=rootfs):
                self.rejected(config_change=lambda c: c.update(rootfs=rootfs))

    def test_reordered_rootfs_changes_exact_config_identity(self):
        release, blobs = fixture()
        config = json.loads(blobs["config_bytes"])
        config["rootfs"]["diff_ids"].reverse()
        blobs["config_bytes"] = encode(config)
        with self.assertRaises(ValueError):
            IDENTITY.verify_published_graph(release, **blobs)

    def test_schema_versions_and_non_index_or_nested_structures_are_rejected(self):
        for change in (lambda i: i.update(schemaVersion=True), lambda i: i.update(schemaVersion=1),
                       lambda i: i.update(mediaType=IDENTITY.OCI_MANIFEST), lambda i: i.update(subject={}),
                       lambda i: i["manifests"][0].update(mediaType=IDENTITY.OCI_INDEX),
                       lambda i: i.update(manifests=[])):
            self.rejected(index_change=change)
        for change in (lambda m: m.update(schemaVersion=True), lambda m: m.update(schemaVersion=1),
                       lambda m: m.update(subject={}), lambda m: m.update(artifactType="example"),
                       lambda m: m.update(layers=[])):
            self.rejected(manifest_change=change)

    def test_descriptor_external_urls_inline_data_and_unrecognized_keys_are_rejected(self):
        for key, value in (("urls", ["https://example.test/image"]), ("data", "YQ=="), ("extra", True)):
            with self.subTest(key=key):
                self.rejected(index_change=lambda i: i["manifests"][0].update({key: value}))
                self.rejected(manifest_change=lambda m: m["config"].update({key: value}))
                self.rejected(manifest_change=lambda m: m["layers"][0].update({key: value}))

    def test_descriptor_sizes_and_types_are_bounded(self):
        for size in (0, -1, True, IDENTITY.METADATA_BYTES + 1, "128"):
            self.rejected(index_change=lambda i: i["manifests"][0].update(size=size))
            self.rejected(manifest_change=lambda m: m["config"].update(size=size))
        for size in (0, -1, True, IDENTITY.MAX_LAYER_BYTES + 1):
            self.rejected(manifest_change=lambda m: m["layers"][0].update(size=size))
        self.rejected(manifest_change=lambda m: m["config"].update(mediaType=IDENTITY.DOCKER_CONFIG))
        self.rejected(manifest_change=lambda m: m["layers"][0].update(mediaType="application/vnd.oci.image.layer.nondistributable.v1.tar+gzip"))
        self.rejected(manifest_change=lambda m: m["layers"][0].update(digest="sha256:" + "A" * 64))

    def test_descriptor_and_total_layer_budgets(self):
        self.rejected(index_change=lambda i: i.update(manifests=i["manifests"] * (IDENTITY.MAX_DESCRIPTORS + 1)))
        self.rejected(manifest_change=lambda m: m.update(layers=[m["layers"][0]] * (IDENTITY.MAX_LAYERS + 1)))
        self.rejected(manifest_change=lambda m: m.update(layers=[{**m["layers"][0], "size": IDENTITY.MAX_LAYER_BYTES}] * 5))

    def test_annotations_are_bounded_and_attestation_cannot_impersonate_platform(self):
        self.rejected(index_change=lambda i: i.update(annotations={"key": "x" * 4097}))
        self.rejected(index_change=lambda i: i["manifests"][0].update(annotations={"vnd.docker.reference.type": "attestation-manifest"}))
        self.rejected(manifest_change=lambda m: m.update(annotations={"key": 1}))
        def add_attestation(index):
            index["manifests"].append({**index["manifests"][0], "platform": {"os": "unknown", "architecture": "unknown"},
                                       "annotations": {"vnd.docker.reference.type": "attestation-manifest"}})
        self.assertEqual(self.verify(index_change=add_attestation).summary()["platform"], PLATFORM)

    def test_json_parser_rejects_duplicates_nonfinite_numbers_and_depth(self):
        for body in (b'{"key":1,"key":2}', b'{"key":NaN}', b'{"key":1.5}', b'{"key":Infinity}',
                     b'[]', b'{} trailing', b'{"key":"\\ud800"}', b'\xff',
                     b'{"key":' + b'[' * 34 + b'0' + b']' * 34 + b'}'):
            with self.subTest(body=body[:24]), self.assertRaises(ValueError):
                IDENTITY.metadata(body)

    def test_metadata_byte_tree_string_and_integer_bounds(self):
        for body in (b" " * (IDENTITY.METADATA_BYTES + 1), encode({"key": "x" * 65537}),
                     encode({"key": [0] * 2049}), encode({"key": 2 ** 64}), encode({str(i): 0 for i in range(257)})):
            with self.subTest(size=len(body)), self.assertRaises(ValueError):
                IDENTITY.metadata(body)

    def test_portable_proof_rejects_wrong_encoding_and_metadata_bounds(self):
        release, blobs = fixture()
        original = IDENTITY.verify_published_graph(release, **blobs).proof()
        for value in ("!", "YQ==\n", "", "A" * (4 * ((IDENTITY.METADATA_BYTES + 2) // 3) + 1), True):
            with self.subTest(value_type=type(value).__name__), self.assertRaises(ValueError):
                IDENTITY.verify_publication_proof(release, {**original, "config": value})
        with self.assertRaises(ValueError):
            IDENTITY.verify_publication_proof(release, {**original, "schema": "other"})

    def test_publication_manifest_remains_a_separate_validated_input(self):
        release, blobs = fixture()
        for changes in ({"tag": "v0.1.0-dev.1"}, {"image": "example.test/controller"}, {"commit": "invalid"},
                        {"runtipiCompatibility": "other"}, {"installationProtocol": "unsupported"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                IDENTITY.verify_published_graph({**release, **changes}, **blobs)

    def test_online_producer_reuses_authoritative_check_and_fixed_digest_endpoints(self):
        release, blobs = fixture()
        published = {**release, "image": release["image"] + "@" + release["digest"]}
        expected_urls = [f"{IDENTITY.CHECK.GHCR}/v2/twentylines/orbis/manifests/{release['digest']}",
                         f"{IDENTITY.CHECK.GHCR}/v2/twentylines/orbis/manifests/{sha(blobs['manifest_bytes'])}",
                         f"{IDENTITY.CHECK.GHCR}/v2/twentylines/orbis/blobs/{sha(blobs['config_bytes'])}"]
        responses = [(blobs["index_bytes"], {"Docker-Content-Digest": release["digest"]}),
                     (blobs["manifest_bytes"], {}), (blobs["config_bytes"], {})]
        with patch.object(IDENTITY.CHECK, "check", return_value=published) as check, \
                patch.object(IDENTITY.CHECK, "read_json", return_value={"token": "test-public-pull"}), \
                patch.object(IDENTITY.CHECK, "read_url", side_effect=responses) as read:
            verified = IDENTITY.produce_publication_proof(TAG, PLATFORM)
        check.assert_called_once_with(TAG)
        self.assertEqual([call.args[0] for call in read.call_args_list], expected_urls)
        self.assertEqual([call.args[1] for call in read.call_args_list],
                         [IDENTITY.METADATA_BYTES, len(blobs["manifest_bytes"]), len(blobs["config_bytes"])])
        self.assertEqual(verified.summary()["publication"], release)

    def test_failed_publication_check_prevents_blob_fetches(self):
        with patch.object(IDENTITY.CHECK, "check", side_effect=ValueError("unpublished")), \
                patch.object(IDENTITY.CHECK, "read_json") as token, patch.object(IDENTITY.CHECK, "read_url") as read, \
                self.assertRaises(ValueError):
            IDENTITY.produce_publication_proof(TAG, PLATFORM)
        token.assert_not_called()
        read.assert_not_called()

    def test_producer_does_not_fetch_config_until_platform_manifest_matches(self):
        release, blobs = fixture()
        with patch.object(IDENTITY.CHECK, "check", return_value={**release, "image": release["image"] + "@" + release["digest"]}), \
                patch.object(IDENTITY.CHECK, "read_json", return_value={"token": "test-public-pull"}), \
                patch.object(IDENTITY.CHECK, "read_url", side_effect=[
                    (blobs["index_bytes"], {"docker-content-digest": release["digest"]}), (b"changed", {})]) as read, \
                self.assertRaises(ValueError):
            IDENTITY.produce_publication_proof(TAG, PLATFORM)
        self.assertEqual(read.call_count, 2)

    def test_producer_rejects_wrong_index_header_before_manifest_fetch(self):
        release, blobs = fixture()
        with patch.object(IDENTITY.CHECK, "check", return_value={**release, "image": release["image"] + "@" + release["digest"]}), \
                patch.object(IDENTITY.CHECK, "read_json", return_value={"token": "test-public-pull"}), \
                patch.object(IDENTITY.CHECK, "read_url", return_value=(blobs["index_bytes"], {})) as read, \
                self.assertRaises(ValueError):
            IDENTITY.produce_publication_proof(TAG, PLATFORM)
        self.assertEqual(read.call_count, 1)


if __name__ == "__main__":
    unittest.main()
