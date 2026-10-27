{
  schema: $schema,
  image: $image,
  tag: $tag,
  commit: $commit,
  digest: $digest,
  releaseChannel: (if ($tag | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")) then "stable" else "nightly" end),
  updatePriority: ($ARGS.named.updatePriority // "normal"),
  criticalThrough: (if ($ARGS.named.criticalThrough // "") == "" then null else $ARGS.named.criticalThrough end),
  platforms: ["linux/amd64", "linux/arm64"],
  runtipiCompatibility: "4.10.1",
  installationProtocol: "orbis.installation-state.v1",
  dataCompatibility: "orbis.data.v1",
  accountIdentifierCompatibility: "orbis.account-identifier.v1",
  migrationFingerprint: $migrationFingerprint
}
