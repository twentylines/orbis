import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { type } from 'arktype';
import { isPublishedOrbisReleaseTag } from '@runtipi/common/schemas/orbis-release-channel';
import {
  controllerConfigurationMetadataSchema,
  controllerConfigurationMetadataV1Schema,
  controllerConfigurationMetadataV2Schema,
  type ControllerConfigurationCapture,
} from './host-controller-config';

export const controllerPublicationLimits = { receiptBytes: 4 * 1024 * 1024, metadataBytes: 1024 * 1024, deadlineMs: 165_000 } as const;
const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const image = type('string').narrow((value) => /^sha256:[a-f0-9]{64}$/.test(value));
const platformPart = type('string').narrow((value) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value));
const platformSchema = type({ os: "'linux'", architecture: "'amd64' | 'arm64'", 'variant?': platformPart }).onUndeclaredKey('reject');
const publicationSchema = type({
  schema: "'orbis.release.v1'",
  image: "'ghcr.io/twentylines/orbis'",
  tag: type('string').narrow(isPublishedOrbisReleaseTag),
  commit: type('string').narrow((value) => /^[a-f0-9]{40}$/.test(value)),
  digest: image,
  runtipiCompatibility: "'4.10.1'",
  'installationProtocol?': "'orbis.installation-state.v1'",
}).onUndeclaredKey('reject');
const proofSchema = type({
  schema: "'orbis.controller-publication-proof.v1'",
  publication: publicationSchema,
  platform: platformSchema,
  index: 'string > 0 & string <= 1398104',
  manifest: 'string > 0 & string <= 1398104',
  config: 'string > 0 & string <= 1398104',
}).onUndeclaredKey('reject');
const receiptV1Schema = controllerConfigurationMetadataV1Schema
  .pick('pointId', 'controller', 'rootIdentity', 'configurationSetSha256')
  .merge({
    version: '1',
    proof: proofSchema,
    preparationSha256: hash,
  })
  .onUndeclaredKey('reject');
const receiptV2Schema = controllerConfigurationMetadataV2Schema
  .pick('pointId', 'controller', 'rootIdentity', 'configurationSetSha256', 'retainedIdentity')
  .merge({ version: '2', proof: proofSchema, preparationSha256: hash })
  .onUndeclaredKey('reject');
const receiptSchema = receiptV1Schema.or(receiptV2Schema);
const expectationSchema = type({
  configuration: controllerConfigurationMetadataSchema,
  publication: publicationSchema,
  platform: platformSchema,
}).onUndeclaredKey('reject');
export type ControllerPublicationExpectation = {
  configuration: ControllerConfigurationCapture['metadata'];
  publication: typeof publicationSchema.infer;
  platform: typeof platformSchema.infer;
};
const invalid = () => new Error('Controller publication preparation could not be verified.');
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const digest = (value: Buffer) => `sha256:${sha(value)}`;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> =>
  record(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => [...required, ...optional].includes(key));
export const canonicalPublicationJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    record(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item,
  );
const equal = (first: unknown, second: unknown) => canonicalPublicationJson(first) === canonicalPublicationJson(second);
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) immutable(child);
  }
  return value;
}

// A separate authenticated publication source supplies this expectation; a response cannot supply its own authority.
export function copyControllerPublicationExpectation(raw: ControllerPublicationExpectation): ControllerPublicationExpectation {
  const value = expectationSchema(raw);
  if (
    value instanceof type.errors ||
    value.publication.tag !== value.configuration.controller.releaseTag ||
    value.publication.digest !== value.configuration.controller.releaseDigest ||
    (value.configuration.version === 1 ? value.configuration.controller.imageReference : value.configuration.retainedIdentity.publishedReference) !==
      `${value.publication.image}@${value.publication.digest}` ||
    (value.configuration.version === 2 &&
      (!equal(value.configuration.retainedIdentity.platform, value.platform) ||
        value.configuration.controller.imageReference !== value.configuration.retainedIdentity.creationReference ||
        value.configuration.controller.imageId !== value.configuration.retainedIdentity.creationReference)) ||
    value.configuration.rootIdentity.mode & 0o022
  )
    throw invalid();
  return immutable(structuredClone(value));
}

function metadata(bytes: Buffer, maximum = controllerPublicationLimits.metadataBytes, maximumString = 65536): Record<string, unknown> {
  if (!bytes.length || bytes.length > maximum) throw invalid();
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw invalid();
  }
  let cursor = 0;
  let nodes = 0;
  const space = () => {
    while (/[\t\n\r ]/.test(text[cursor] ?? 'x')) cursor++;
  };
  const string = () => {
    const start = cursor++;
    while (cursor < text.length) {
      const char = text[cursor++];
      if (char === '\\') cursor++;
      else if (char === '"') break;
    }
    const result: string = JSON.parse(text.slice(start, cursor));
    if (result.length > maximumString || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result)) throw invalid();
    return result;
  };
  const visit = (depth: number) => {
    if (++nodes > 50_000 || depth > 32) throw invalid();
    space();
    if (text[cursor] === '{') {
      cursor++;
      space();
      const keys = new Set<string>();
      if (text[cursor] !== '}') {
        for (;;) {
          space();
          const key = string();
          if (keys.has(key) || key.length > 1024 || keys.size >= 256) throw invalid();
          keys.add(key);
          space();
          cursor++;
          visit(depth + 1);
          space();
          if (text[cursor++] !== ',') break;
        }
      } else cursor++;
    } else if (text[cursor] === '[') {
      cursor++;
      space();
      let count = 0;
      if (text[cursor] !== ']') {
        for (;;) {
          if (++count > 2048) throw invalid();
          visit(depth + 1);
          space();
          if (text[cursor++] !== ',') break;
        }
      } else cursor++;
    } else if (text[cursor] === '"') string();
    else {
      const start = cursor;
      while (cursor < text.length && !/[\t\n\r ,\]}]/.test(text[cursor] ?? '')) cursor++;
      const token = text.slice(start, cursor);
      if (!['true', 'false', 'null'].includes(token)) {
        if (!/^-?(?:0|[1-9][0-9]*)$/.test(token)) throw invalid();
        const number = BigInt(token);
        if (number < -(2n ** 63n) || number >= 2n ** 64n) throw invalid();
      }
    }
  };
  visit(0);
  space();
  if (cursor !== text.length || !record(parsed)) throw invalid();
  return parsed;
}
export function parseControllerPublicationResponse(bytes: Buffer) {
  return metadata(bytes, controllerPublicationLimits.receiptBytes, 1398104);
}
const ociIndex = 'application/vnd.oci.image.index.v1+json';
const dockerIndex = 'application/vnd.docker.distribution.manifest.list.v2+json';
const ociManifest = 'application/vnd.oci.image.manifest.v1+json';
const dockerManifest = 'application/vnd.docker.distribution.manifest.v2+json';
function annotations(value: unknown) {
  if (
    !record(value) ||
    Object.keys(value).length > 32 ||
    Object.entries(value).some(([key, item]) => !key.length || key.length > 256 || typeof item !== 'string' || item.length > 4096) ||
    Buffer.byteLength(canonicalPublicationJson(value)) > 16384
  )
    throw invalid();
}
function graphPlatform(value: unknown) {
  if (!exact(value, ['os', 'architecture'], ['variant']) || Object.values(value).some((part) => !platformPart.allows(part))) throw invalid();
  return value;
}
function descriptor(value: unknown, mediaTypes: string[], maximum: number, platform = false) {
  if (
    !exact(value, ['mediaType', 'digest', 'size', ...(platform ? ['platform'] : [])], ['annotations']) ||
    typeof value.mediaType !== 'string' ||
    !mediaTypes.includes(value.mediaType) ||
    !image.allows(value.digest) ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    value.size > maximum
  )
    throw invalid();
  if (value.annotations !== undefined) annotations(value.annotations);
  if (platform) graphPlatform(value.platform);
  return value as Record<string, unknown> & { mediaType: string; digest: string; size: number };
}
function decodeBlob(value: string) {
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > controllerPublicationLimits.metadataBytes || bytes.toString('base64') !== value) throw invalid();
  return bytes;
}
function bound(bytes: Buffer, expected: { digest: string; size: number }) {
  if (bytes.length !== expected.size || digest(bytes) !== expected.digest) throw invalid();
  return metadata(bytes);
}
function verifyGraph(proof: typeof proofSchema.infer, expected: ControllerPublicationExpectation) {
  if (!equal(proof.publication, expected.publication) || !equal(proof.platform, expected.platform)) throw invalid();
  const indexBytes = decodeBlob(proof.index);
  if (digest(indexBytes) !== expected.publication.digest) throw invalid();
  const index = metadata(indexBytes);
  if (
    !exact(index, ['schemaVersion', 'mediaType', 'manifests'], ['annotations']) ||
    index.schemaVersion !== 2 ||
    ![ociIndex, dockerIndex].includes(String(index.mediaType)) ||
    !Array.isArray(index.manifests) ||
    !index.manifests.length ||
    index.manifests.length > 256
  )
    throw invalid();
  if (index.annotations !== undefined) annotations(index.annotations);
  const kind = index.mediaType === ociIndex ? ociManifest : dockerManifest;
  const selected = index.manifests
    .map((value) => descriptor(value, [kind], controllerPublicationLimits.metadataBytes, true))
    .filter((value) => equal(value.platform, expected.platform));
  if (selected.length !== 1 || !selected[0]) throw invalid();
  if (record(selected[0].annotations) && selected[0].annotations['vnd.docker.reference.type'] === 'attestation-manifest') throw invalid();
  const manifest = bound(decodeBlob(proof.manifest), selected[0]);
  if (
    !exact(manifest, ['schemaVersion', 'mediaType', 'config', 'layers'], ['annotations']) ||
    manifest.schemaVersion !== 2 ||
    manifest.mediaType !== kind ||
    !Array.isArray(manifest.layers) ||
    !manifest.layers.length ||
    manifest.layers.length > 512
  )
    throw invalid();
  if (manifest.annotations !== undefined) annotations(manifest.annotations);
  const configDescriptor = descriptor(
    manifest.config,
    [kind === ociManifest ? 'application/vnd.oci.image.config.v1+json' : 'application/vnd.docker.container.image.v1+json'],
    controllerPublicationLimits.metadataBytes,
  );
  let total = 0;
  for (const value of manifest.layers) {
    total += descriptor(
      value,
      kind === ociManifest
        ? ['application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip']
        : ['application/vnd.docker.image.rootfs.diff.tar.gzip'],
      16 * 1024 ** 3,
    ).size;
    if (total > 64 * 1024 ** 3) throw invalid();
  }
  const config = bound(decodeBlob(proof.config), configDescriptor);
  if (
    !exact(config, ['architecture', 'os', 'config', 'rootfs'], ['variant', 'created', 'author', 'history']) ||
    !record(config.config) ||
    !exact(config.rootfs, ['type', 'diff_ids']) ||
    config.rootfs.type !== 'layers' ||
    !Array.isArray(config.rootfs.diff_ids) ||
    config.rootfs.diff_ids.length !== manifest.layers.length ||
    config.rootfs.diff_ids.some((id) => !image.allows(id))
  )
    throw invalid();
  const platform = Object.fromEntries(['os', 'architecture', 'variant'].filter((key) => Object.hasOwn(config, key)).map((key) => [key, config[key]]));
  if (!equal(graphPlatform(platform), expected.platform)) throw invalid();
  const labels = config.config.Labels;
  if (
    !record(labels) ||
    Object.keys(labels).length > 128 ||
    Object.entries(labels).some(([key, value]) => key.length > 256 || typeof value !== 'string' || value.length > 4096) ||
    labels['org.opencontainers.image.source'] !== 'https://github.com/twentylines/orbis' ||
    labels['org.opencontainers.image.version'] !== expected.publication.tag ||
    labels['org.opencontainers.image.revision'] !== expected.publication.commit ||
    (expected.publication.installationProtocol !== undefined &&
      labels['io.orbis.installation-protocol'] !== expected.publication.installationProtocol)
  )
    throw invalid();
  return { platformManifestDigest: selected[0].digest, configDigest: configDescriptor.digest, rootfsDiffIds: config.rootfs.diff_ids as string[] };
}

export class ControllerPublicationReceipt {
  readonly #bytes: Buffer;
  constructor(
    readonly metadata: Readonly<Omit<typeof receiptSchema.infer, 'proof'> & ReturnType<typeof verifyGraph>>,
    bytes: Buffer,
  ) {
    this.metadata = immutable(structuredClone(metadata));
    this.#bytes = Buffer.from(bytes);
    Object.freeze(this);
  }
  read() {
    return Buffer.from(this.#bytes);
  }
  toJSON(): never {
    throw new Error('Controller publication receipt is private.');
  }
}

export function decodeControllerPublicationReceipt(raw: unknown, supplied: ControllerPublicationExpectation) {
  const expected = copyControllerPublicationExpectation(supplied);
  const value = receiptSchema(raw);
  if (
    value instanceof type.errors ||
    value.pointId !== expected.configuration.pointId ||
    value.configurationSetSha256 !== expected.configuration.configurationSetSha256 ||
    !equal(value.controller, expected.configuration.controller) ||
    !equal(value.rootIdentity, expected.configuration.rootIdentity) ||
    value.version !== expected.configuration.version ||
    (value.version === 2 && (expected.configuration.version !== 2 || !equal(value.retainedIdentity, expected.configuration.retainedIdentity)))
  )
    throw invalid();
  const bytes = Buffer.from(canonicalPublicationJson(value));
  if (bytes.length > controllerPublicationLimits.receiptBytes) throw invalid();
  const { preparationSha256, ...descriptor } = value;
  if (sha(`orbis.controller-publication-capture.v${value.version}\n${canonicalPublicationJson(descriptor)}`) !== preparationSha256) throw invalid();
  const graph = verifyGraph(value.proof, expected);
  if (value.version === 2) {
    const retained = value.retainedIdentity;
    if (
      retained.proofDigest !== `sha256:${sha(canonicalPublicationJson(value.proof))}` ||
      retained.configDigest !== graph.configDigest ||
      retained.platformManifestDigest !== graph.platformManifestDigest ||
      retained.creationReference !== (retained.archiveKind === 'oci' ? graph.platformManifestDigest : graph.configDigest)
    )
      throw invalid();
  }
  const { proof: _proof, ...summary } = value;
  return new ControllerPublicationReceipt({ ...summary, ...graph }, bytes);
}
