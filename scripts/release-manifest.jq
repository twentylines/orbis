{
  schema: $schema,
  image: $image,
  tag: $tag,
  commit: $commit,
  digest: $digest,
  platforms: ["linux/amd64", "linux/arm64"],
  runtipiCompatibility: "4.10.1",
  installationProtocol: "orbis.installation-state.v1",
  dataCompatibility: "orbis.data.v1",
  accountIdentifierCompatibility: "orbis.account-identifier.v1",
  migrationFingerprint: $migrationFingerprint
}
