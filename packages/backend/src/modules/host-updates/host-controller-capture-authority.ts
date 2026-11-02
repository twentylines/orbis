import { createHash } from 'node:crypto';
import { type } from 'arktype';
import { timeMachineHashSchema as hash, timeMachineIdSchema as id } from '@runtipi/common/schemas/time-machine';
import {
  canonicalPublicationJson as canonical,
  copyControllerPublicationExpectation,
  decodeControllerPublicationReceipt,
  parseControllerPublicationResponse,
  type ControllerPublicationExpectation,
  type ControllerPublicationReceipt,
} from './host-controller-publication';
import type { RetainedImage } from '../system-backups/backup-image-retention';
import { decodeProxyHostIdentity, proxyHostIdentitySchema } from './host-proxy-identity';

export const controllerAuthorityEntryName = 'controller-authority/receipt.json';
export const controllerAuthorityLimit = 64 * 1024;
const digest = type('string').narrow((value) => /^sha256:[a-f0-9]{64}$/.test(value));
const schemaV1 = type({
  schema: "'orbis.controller-capture-authority.v1'",
  version: '1',
  pointId: id,
  configurationSetSha256: hash,
  preparationSha256: hash,
  publicationProofSha256: hash,
  rootIdentitySha256: hash,
  publication: 'unknown',
  platform: 'unknown',
  archive: type({
    kind: "'oci' | 'docker'",
    sha256: hash,
    bytes: '1 <= number.integer <= 68719476736',
    archiveRootId: digest,
    platformManifestDigest: digest,
    configDigest: digest,
    sourceImageId: digest,
    creationReference: digest,
  }).onUndeclaredKey('reject'),
  finalizedAt: '0 < number.integer <= 9007199254740991',
  authoritySha256: hash,
}).onUndeclaredKey('reject');
const schemaV2 = schemaV1
  .omit('schema', 'version')
  .merge({
    schema: "'orbis.controller-capture-authority.v2'",
    version: '2',
    proxyHostIdentity: proxyHostIdentitySchema,
  })
  .onUndeclaredKey('reject');
const schemaV4 = schemaV2
  .omit('schema', 'version')
  .merge({
    schema: "'orbis.controller-capture-authority.v4'",
    version: '4',
    appRuntimeSha256: hash,
    appRuntimeDaemonSha256: hash,
  })
  .onUndeclaredKey('reject');
const schema = schemaV1.or(schemaV2).or(schemaV4);
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const fail = () => new Error('Controller capture authority could not be verified.');
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
export class ControllerCaptureAuthorityReceipt {
  readonly #bytes: Buffer;
  constructor(
    readonly metadata: typeof schema.infer,
    bytes: Buffer,
  ) {
    immutable(metadata);
    this.#bytes = Buffer.from(bytes);
    Object.freeze(this);
  }
  read() {
    return Buffer.from(this.#bytes);
  }
  toJSON(): never {
    throw fail();
  }
}
export function decodeControllerCaptureAuthority(
  raw: unknown,
  supplied: ControllerPublicationExpectation,
  receipt: ControllerPublicationReceipt,
  image: RetainedImage,
) {
  const expected = copyControllerPublicationExpectation(supplied);
  const proof = decodeControllerPublicationReceipt(parseControllerPublicationResponse(receipt.read()), expected);
  const value = schema(raw);
  if (value instanceof type.errors || Buffer.byteLength(canonical(value)) > controllerAuthorityLimit) throw fail();
  const { authoritySha256, ...descriptor } = value;
  if (
    sha(`${value.schema}\n${canonical(descriptor)}`) !== authoritySha256 ||
    value.pointId !== expected.configuration.pointId ||
    value.configurationSetSha256 !== expected.configuration.configurationSetSha256 ||
    value.preparationSha256 !== proof.metadata.preparationSha256 ||
    value.publicationProofSha256 !== sha(proof.read()) ||
    value.rootIdentitySha256 !== sha(canonical(expected.configuration.rootIdentity)) ||
    canonical(value.publication) !== canonical(expected.publication) ||
    canonical(value.platform) !== canonical(expected.platform) ||
    image.imageId !== expected.configuration.controller.imageId ||
    image.identity.configId !== proof.metadata.configDigest ||
    (image.identity.kind === 'oci' &&
      (image.identity.manifestId !== proof.metadata.platformManifestDigest || canonical(image.identity.platform) !== canonical(expected.platform))) ||
    value.archive.kind !== image.identity.kind ||
    value.archive.sha256 !== image.sha256 ||
    value.archive.bytes !== image.bytes ||
    value.archive.archiveRootId !== image.identity.archiveRootId ||
    value.archive.configDigest !== proof.metadata.configDigest ||
    value.archive.platformManifestDigest !== proof.metadata.platformManifestDigest ||
    value.archive.sourceImageId !== expected.configuration.controller.imageId ||
    value.archive.creationReference !== (image.identity.kind === 'oci' ? image.identity.manifestId : image.identity.configId)
  )
    throw fail();
  if (value.version === 2 || value.version === 4) decodeProxyHostIdentity(value.proxyHostIdentity, expected.configuration.rootIdentity.pathSha256);
  return new ControllerCaptureAuthorityReceipt(structuredClone(value), Buffer.from(canonical(value)));
}
