import copy
import importlib.util
import unittest
from pathlib import Path

from test_orbis_controller_identity import fixture

SPEC = importlib.util.spec_from_file_location("orbis_host_identity", Path(__file__).with_name("orbis-host-identity.py"))
assert SPEC and SPEC.loader
HOST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HOST)
P = HOST.PUBLICATION
ROOT = "/srv/orbis"
CONTEXT = "default"
FILES = {name: "1" * 64 for name in HOST.FILES}


def setup(kind="oci"):
    release, blobs = fixture(docker=kind == "docker")
    graph = P.verify_published_graph(release, **blobs)
    proof = P.canonical(graph.proof())
    descriptor = {"schema": HOST.RETAINED_SCHEMA, "root": ROOT, "dockerContext": CONTEXT, "files": FILES,
                  "pointId": "sha256:" + "2" * 64, "configurationDigest": "sha256:" + "3" * 64,
                  "archiveRootId": "sha256:" + "4" * 64, "archiveKind": kind, "proofDigest": P.digest(proof),
                  "publication": release, "platform": blobs["platform"], "platformManifestDigest": graph.manifest_digest,
                  "configDigest": graph.config_digest, "sourceImageId": release["digest"],
                  "creationReference": graph.creation_reference(kind)}
    authority = {key: descriptor[key] for key in ("root", "dockerContext", "pointId", "configurationDigest", "archiveRootId",
                                                "proofDigest", "publication")}
    authority.update(schema=HOST.AUTHORITY_SCHEMA, descriptorDigest=P.digest(P.canonical(descriptor)))
    observed = {"creationReference": descriptor["creationReference"], "imageId": descriptor["creationReference"],
                "configDigest": graph.config_digest, "platform": blobs["platform"], "rootfsDiffIds": list(graph.rootfs_diff_ids)}
    return descriptor, dict(root=ROOT, context=CONTEXT, current_files=FILES, expected_release=release,
                            observation=observed, retained_authority=authority, proof=proof)


class HostIdentityTests(unittest.TestCase):
    def test_retained_oci_and_docker_keep_all_identities_separate(self):
        for kind in ("oci", "docker"):
            with self.subTest(kind=kind):
                descriptor, args = setup(kind)
                resolved = HOST.resolve_host_identity(P.canonical(descriptor), **args)
                identity = resolved.controller()
                self.assertEqual(resolved.mode, "retained")
                self.assertEqual(resolved.publication(), args["expected_release"])
                self.assertEqual(identity["sourceImageId"], args["expected_release"]["digest"])
                self.assertNotEqual(identity["sourceImageId"], identity["creationReference"])
                self.assertNotEqual(identity["platformManifestDigest"], identity["configDigest"])
                self.assertNotIn("repoDigests", identity)

    def test_untrusted_descriptor_edits_cannot_rebind_root_authority(self):
        descriptor, args = setup()
        for key in descriptor:
            with self.subTest(key=key):
                edited = copy.deepcopy(descriptor)
                edited[key] = "forged"
                with self.assertRaises(ValueError):
                    HOST.resolve_host_identity(P.canonical(edited), **args)

    def test_reauthenticated_but_inconsistent_descriptors_fail(self):
        descriptor, args = setup()
        for key in ("pointId", "configurationDigest", "archiveRootId", "proofDigest", "platformManifestDigest",
                    "configDigest", "creationReference", "platform", "publication", "archiveKind", "files", "root", "dockerContext"):
            with self.subTest(key=key):
                edited = copy.deepcopy(descriptor)
                edited[key] = "sha256:" + "9" * 64
                altered_args = copy.deepcopy(args)
                body = P.canonical(edited)
                altered_args["retained_authority"]["descriptorDigest"] = P.digest(body)
                with self.assertRaises(ValueError):
                    HOST.resolve_host_identity(body, **altered_args)

    def test_missing_or_extra_authority_never_becomes_trusted(self):
        descriptor, args = setup()
        for key in args["retained_authority"]:
            changed = copy.deepcopy(args)
            del changed["retained_authority"][key]
            with self.subTest(key=key), self.assertRaises(ValueError):
                HOST.resolve_host_identity(P.canonical(descriptor), **changed)
        for authority in (None, {}, {**args["retained_authority"], "approved": True}):
            changed = {**args, "retained_authority": authority}
            with self.assertRaises(ValueError):
                HOST.resolve_host_identity(P.canonical(descriptor), **changed)

    def test_observation_mismatch_and_bare_id_fail(self):
        descriptor, args = setup()
        for key in args["observation"]:
            changed = copy.deepcopy(args)
            changed["observation"][key] = "sha256:" + "9" * 64
            with self.subTest(key=key), self.assertRaises(ValueError):
                HOST.resolve_host_identity(P.canonical(descriptor), **changed)
        with self.assertRaises(ValueError):
            HOST.resolve_host_identity(P.canonical(descriptor), **{**args, "observation": descriptor["creationReference"]})

    def test_proof_tampering_and_duplicate_json_fail(self):
        descriptor, args = setup()
        for proof in (b"{}", args["proof"] + b" "):
            with self.assertRaises(ValueError):
                HOST.resolve_host_identity(P.canonical(descriptor), **{**args, "proof": proof})
        body = P.canonical(descriptor)
        duplicate = b'{"schema":"forged",' + body[1:]
        args["retained_authority"]["descriptorDigest"] = P.digest(duplicate)
        with self.assertRaises(ValueError):
            HOST.resolve_host_identity(duplicate, **args)

    def test_forged_graph_cannot_replace_independent_publication(self):
        descriptor, args = setup()
        other_release, other_blobs = fixture(config_change=lambda value: value["rootfs"]["diff_ids"].__setitem__(0, "sha256:" + "8" * 64))
        graph = P.verify_published_graph(other_release, **other_blobs)
        proof = P.canonical(graph.proof())
        descriptor["proofDigest"] = P.digest(proof)
        args["proof"] = proof
        args["retained_authority"]["proofDigest"] = P.digest(proof)
        args["retained_authority"]["descriptorDigest"] = P.digest(P.canonical(descriptor))
        with self.assertRaises(ValueError):
            HOST.resolve_host_identity(P.canonical(descriptor), **args)

    def test_v1_still_requires_published_alias_and_exact_files(self):
        release, _ = fixture()
        descriptor = dict(schema="orbis.host.v1", root=ROOT, dockerContext=CONTEXT, tag=release["tag"], digest=release["digest"], files=FILES)
        published = release["image"] + "@" + release["digest"]
        labels = {"org.opencontainers.image.source": P.SOURCE, "org.opencontainers.image.version": release["tag"],
                  "org.opencontainers.image.revision": release["commit"], "io.orbis.installation-protocol": release["installationProtocol"]}
        args = dict(root=ROOT, context=CONTEXT, current_files=FILES, expected_release=release,
                    observation=dict(creationReference=published, repoDigests=[published], labels=labels))
        self.assertEqual(HOST.resolve_host_identity(P.canonical(descriptor), **args).mode, "published")
        for observation in ({**args["observation"], "repoDigests": []},
                            {**args["observation"], "creationReference": release["digest"]},
                            {**args["observation"], "labels": {**labels, "org.opencontainers.image.revision": "0" * 40}}):
            with self.assertRaises(ValueError):
                HOST.resolve_host_identity(P.canonical(descriptor), **{**args, "observation": observation})
        for key in descriptor:
            edited = copy.deepcopy(descriptor)
            del edited[key]
            with self.subTest(key=key), self.assertRaises(ValueError):
                HOST.resolve_host_identity(P.canonical(edited), **args)
        with self.assertRaises(ValueError):
            HOST.resolve_host_identity(P.canonical(descriptor), **{**args, "retained_authority": {}})

    def test_unknown_schema_fields_and_invalid_bindings_fail(self):
        descriptor, args = setup()
        for edited in ({**descriptor, "schema": "orbis.host.v2"}, {**descriptor, "approved": True}):
            with self.assertRaises(ValueError):
                HOST.resolve_host_identity(P.canonical(edited), **args)
        for root in ("relative", "/srv/../orbis", "/srv//orbis", "/srv/orbis/"):
            with self.subTest(root=root), self.assertRaises(ValueError):
                HOST.resolve_host_identity(P.canonical(descriptor), **{**args, "root": root})


if __name__ == "__main__":
    unittest.main()
