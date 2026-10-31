import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import { isPublishedOrbisReleaseTag } from '@runtipi/common/schemas/orbis-release-channel';

export const controllerConfigPaths = [
  'docker-compose.yml',
  '.env',
  'user-config/tipi-compose.yml',
  'orbis-host-compose.yml',
  'orbis-compose.yml',
] as const;
export type ControllerConfigPath = (typeof controllerConfigPaths)[number];
export type ControllerCaptureIdentity = { pointId: string; controllerId: string; imageId: string };
const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const image = type('string').narrow((value) => /^sha256:[a-f0-9]{64}$/.test(value));
const identifier = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const decimal = type('string').narrow((value) => /^(?:0|[1-9][0-9]{0,19})$/.test(value));
const owner = type('0 <= number.integer <= 4294967295');
const mode = type('0 <= number.integer <= 4095');
const member = type.enumerated(...controllerConfigPaths);
const absent = type({ path: member, present: 'false' }).onUndeclaredKey('reject');
const present = type({
  path: member,
  present: 'true',
  bytes: '0 <= number.integer <= 1048576',
  mode,
  uid: owner,
  gid: owner,
  device: decimal,
  inode: decimal,
  mtimeNs: decimal,
  ctimeNs: decimal,
  sha256: hash,
  data: 'string <= 1398104',
}).onUndeclaredKey('reject');
const schema = type({
  version: '1',
  pointId: identifier,
  configurationSetSha256: hash,
  controller: type({
    id: hash,
    imageId: image,
    imageReference: type('string').narrow((value) => /^ghcr\.io\/twentylines\/orbis@sha256:[a-f0-9]{64}$/.test(value)),
    project: "'runtipi'",
    service: "'runtipi'",
    startedAt: 'string > 0 & string <= 80',
    releaseTag: type('string').narrow(isPublishedOrbisReleaseTag),
    releaseDigest: image,
  }).onUndeclaredKey('reject'),
  rootIdentity: type({ device: decimal, inode: decimal, uid: owner, gid: owner, mode, pathSha256: hash }).onUndeclaredKey('reject'),
  files: present.or(absent).array().exactlyLength(5),
}).onUndeclaredKey('reject');
type Wire = typeof schema.infer;
type MetadataFile = Omit<typeof present.infer, 'data'> | typeof absent.infer;
type CaptureMetadata = Omit<Wire, 'files'> & { files: MetadataFile[] };
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const invalid = () => new Error('Controller configuration capture could not be verified.');
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) immutable(item);
  }
  return value;
}

export async function controllerCaptureSocketIdentity(socket: string) {
  const parent = path.dirname(socket);
  if (path.resolve(socket) !== socket || (await fs.realpath(parent)) !== parent) throw invalid();
  const directory = await fs.lstat(parent, { bigint: true });
  const endpoint = await fs.lstat(socket, { bigint: true });
  const uid = BigInt(process.getuid?.() ?? -1);
  if (
    !directory.isDirectory() ||
    directory.uid !== uid ||
    directory.mode & 0o022n ||
    !endpoint.isSocket() ||
    endpoint.uid !== uid ||
    endpoint.nlink !== 1n ||
    endpoint.mode & 0o077n
  )
    throw invalid();
  return [directory, endpoint].map((stat) => [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.ctimeNs].join(':')).join('/');
}

// Private server input for an encrypted envelope. Never serialize this object into a web response.
export class ControllerConfigurationCapture {
  readonly #bytes: Map<ControllerConfigPath, Buffer>;
  constructor(
    readonly metadata: Readonly<CaptureMetadata>,
    bytes: Map<ControllerConfigPath, Buffer>,
  ) {
    this.#bytes = bytes;
  }
  read(name: ControllerConfigPath) {
    const value = this.#bytes.get(name);
    return value ? Buffer.from(value) : null;
  }
  toJSON(): never {
    throw new Error('Controller configuration capture is private.');
  }
}

export function validateControllerCaptureIdentity(value: ControllerCaptureIdentity) {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== 3 ||
    Object.keys(value).some((key) => !['pointId', 'controllerId', 'imageId'].includes(key)) ||
    !identifier.allows(value.pointId) ||
    !hash.allows(value.controllerId) ||
    !image.allows(value.imageId)
  )
    throw invalid();
}
export function decodeControllerConfigurationCapture(raw: unknown, expected: ControllerCaptureIdentity) {
  validateControllerCaptureIdentity(expected);
  const value = schema(raw);
  if (
    value instanceof type.errors ||
    value.pointId !== expected.pointId ||
    value.controller.id !== expected.controllerId ||
    value.controller.imageId !== expected.imageId ||
    value.controller.imageReference !== `ghcr.io/twentylines/orbis@${value.controller.releaseDigest}` ||
    value.rootIdentity.mode & 0o022
  )
    throw invalid();
  const bytes = new Map<ControllerConfigPath, Buffer>();
  let total = 0;
  const files = value.files.map((item, index): MetadataFile => {
    if (item.path !== controllerConfigPaths[index]) throw invalid();
    if (!item.present) {
      if (['docker-compose.yml', '.env', 'orbis-compose.yml'].includes(item.path)) throw invalid();
      return item;
    }
    const buffer = Buffer.from(item.data, 'base64');
    total += buffer.length;
    if (
      buffer.toString('base64') !== item.data ||
      buffer.length !== item.bytes ||
      item.mode & 0o7022 ||
      createHash('sha256').update(buffer).digest('hex') !== item.sha256 ||
      total > 4 * 1024 * 1024
    )
      throw invalid();
    bytes.set(item.path, buffer);
    const { data: _data, ...metadata } = item;
    return metadata;
  });
  const { configurationSetSha256, ...descriptor } = { ...value, files };
  if (
    createHash('sha256')
      .update(`orbis.controller-config.v1\n${canonical(descriptor)}`)
      .digest('hex') !== configurationSetSha256
  )
    throw invalid();
  return new ControllerConfigurationCapture(immutable({ ...descriptor, configurationSetSha256 }), bytes);
}
