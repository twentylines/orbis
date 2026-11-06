import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { TimeMachineCoreMetadata } from '@runtipi/common/schemas/time-machine';
import { readTarArchive } from '@/core/archive/tar-metadata';
import { backupGcmPlaintextLimit } from './backup-crypto';
import {
  retainedImageLimits,
  validateRetainedImageInventory,
  verifyRetainedImageArchives,
  type RetainedImage,
  type RetainedImageInventory,
} from './backup-image-retention';

export const corePayloadLimits = { manifestBytes: 2 * 1024 * 1024, reserveBytes: 1024 * 1024, chunkBytes: 64 * 1024 } as const;
export type CorePayloadExpectation = {
  pointId: string;
  sourceSha256: string;
  checkpointSha256: string;
  captureReceiptSha256: string;
  resourceCount: number;
  images: Record<'controller' | 'database' | 'queue', string>;
  compatibility: TimeMachineCoreMetadata['compatibility'];
  checkpoint: { bytes: number; sha256: string };
};
export type CorePayloadEntry = { name: string; bytes: number; sha256: string };
export type CorePayloadManifest = Readonly<{
  schema: 'orbis.time-machine-core.v1';
  pointId: string;
  sourceSha256: string;
  checkpointSha256: string;
  captureReceiptSha256: string;
  imageInventorySha256: string;
  resourceCount: number;
  compatibility: CorePayloadExpectation['compatibility'];
  inventory: RetainedImageInventory;
  entries: readonly CorePayloadEntry[];
}>;
declare const verifiedCorePayload: unique symbol;
export type VerifiedCorePayload = { readonly [verifiedCorePayload]: true };
type Stat = Awaited<ReturnType<FileHandle['stat']>>;
type File = { file: string; entry: CorePayloadEntry; before: Stat };
type Prepared = { manifest: CorePayloadManifest; metadata: Buffer; bytes: number; files: File[]; directories: { file: string; before: Stat }[] };
const capabilities = new WeakMap<VerifiedCorePayload, Prepared>();
const fail = () => new Error('Core payload could not be verified.');
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const same = (a: Stat, b: Stat) =>
  ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
const sameDirectory = (a: Stat, b: Stat) => ['dev', 'ino', 'mode', 'uid', 'gid'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
const owned = (stat: Stat) => typeof process.getuid === 'function' && stat.uid === process.getuid();
export const canonicalCoreJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
export function validateCorePayloadExpectation(value: unknown): CorePayloadExpectation {
  if (
    !exact(value, [
      'pointId',
      'sourceSha256',
      'checkpointSha256',
      'captureReceiptSha256',
      'resourceCount',
      'images',
      'compatibility',
      'checkpoint',
    ]) ||
    typeof value.pointId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.pointId) ||
    !hash(value.sourceSha256) ||
    !hash(value.checkpointSha256) ||
    !hash(value.captureReceiptSha256) ||
    !Number.isSafeInteger(value.resourceCount) ||
    (value.resourceCount as number) < 1 ||
    (value.resourceCount as number) > 4096 ||
    !exact(value.images, ['controller', 'database', 'queue']) ||
    Object.values(value.images).some((id) => typeof id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(id)) ||
    !exact(value.checkpoint, ['bytes', 'sha256']) ||
    !hash(value.checkpoint.sha256) ||
    !Number.isSafeInteger(value.checkpoint.bytes) ||
    (value.checkpoint.bytes as number) < 1 ||
    (value.checkpoint.bytes as number) > backupGcmPlaintextLimit - corePayloadLimits.reserveBytes ||
    !exact(value.compatibility, ['os', 'architecture', 'database', 'storageFormat']) ||
    value.compatibility.os !== 'linux' ||
    !['amd64', 'arm64'].includes(value.compatibility.architecture as string) ||
    value.compatibility.storageFormat !== 'physical-pgdata.v1' ||
    !exact(value.compatibility.database, ['engine', 'major']) ||
    value.compatibility.database.engine !== 'postgresql' ||
    !Number.isSafeInteger(value.compatibility.database.major) ||
    (value.compatibility.database.major as number) < 1 ||
    (value.compatibility.database.major as number) > 99
  )
    throw fail();
  return JSON.parse(canonicalCoreJson(value)) as CorePayloadExpectation;
}
async function privateDirectory(file: string) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || (await fs.realpath(file)) !== file) throw fail();
  const before = await fs.lstat(file);
  if (!before.isDirectory() || !owned(before) || (before.mode & 0o7777) !== 0o700) throw fail();
  return { file, before };
}
async function open(file: string, bytes: number) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || (await fs.realpath(file)) !== file) throw fail();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      !owned(before) ||
      before.nlink !== 1 ||
      ![0o400, 0o600].includes(before.mode & 0o7777) ||
      before.size !== bytes ||
      !same(before, await fs.lstat(file))
    )
      throw fail();
    return { handle, before };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function* chunks(handle: FileHandle, bytes: number, signal: AbortSignal) {
  let offset = 0;
  while (offset < bytes) {
    signal.throwIfAborted();
    const chunk = Buffer.allocUnsafe(Math.min(corePayloadLimits.chunkBytes, bytes - offset));
    const result = await handle.read(chunk, 0, chunk.length, offset);
    if (!result.bytesRead) throw fail();
    offset += result.bytesRead;
    yield chunk.subarray(0, result.bytesRead);
  }
  signal.throwIfAborted();
  const tail = Buffer.alloc(1);
  if ((await handle.read(tail, 0, 1, bytes)).bytesRead) throw fail();
}
async function checksum(handle: FileHandle, entry: CorePayloadEntry, signal: AbortSignal) {
  const sum = createHash('sha256');
  for await (const chunk of chunks(handle, entry.bytes, signal)) sum.update(chunk);
  if (sum.digest('hex') !== entry.sha256) throw fail();
}
// Archive authenticity remains the retained-image verifier's responsibility. Docker's
// legacy identity has no platform field, so inspect only its authenticated config here.
async function checkPlatform(file: string, image: RetainedImage, compatibility: CorePayloadExpectation['compatibility'], signal: AbortSignal) {
  if (image.identity.platform) {
    if (image.identity.platform.os !== compatibility.os || image.identity.platform.architecture !== compatibility.architecture) throw fail();
    return;
  }
  const configHash = image.identity.configId.slice(7);
  let selected = false;
  let found = false;
  const parts: Buffer[] = [];
  let count = 0;
  await readTarArchive(file, false, signal, {
    strict: true,
    collectEntries: false,
    maxEntries: retainedImageLimits.entries,
    maxExpandedBytes: image.bytes,
    onEntry: async (entry) => {
      selected = [`${configHash}.json`, `blobs/sha256/${configHash}`].includes(entry.path);
      if (selected && (found || entry.size > retainedImageLimits.metadataBytes)) throw fail();
      if (selected) found = true;
    },
    onData: async (chunk) => {
      if (!selected) return;
      count += chunk.length;
      if (count > retainedImageLimits.metadataBytes) throw fail();
      parts.push(Buffer.from(chunk));
    },
  });
  const data = Buffer.concat(parts);
  if (!found || sha(data) !== configHash) throw fail();
  const config = JSON.parse(data.toString('utf8'));
  if (config.os !== compatibility.os || config.architecture !== compatibility.architecture) throw fail();
}

/** This expectation is not an HTTP/user authentication input. The authenticated root
 * client must independently bind it to the active
 * job and source. This transport verifier does not establish root authority or queue
 * drain. The source-root client and checkpoint packer are not implemented here. */
export async function prepareCorePayload(options: {
  expectation: CorePayloadExpectation;
  checkpointFile: string;
  imageInventory: unknown;
  imageDirectory: string;
  signal: AbortSignal;
}): Promise<VerifiedCorePayload> {
  options.signal.throwIfAborted();
  const expected = validateCorePayloadExpectation(options.expectation);
  const inventory = validateRetainedImageInventory(options.imageInventory);
  if (
    inventory.images.length < 1 ||
    inventory.images.length > 3 ||
    inventory.bindings.length !== 3 ||
    inventory.bindings
      .map((item) => item.key)
      .sort()
      .join(',') !== 'controller,database,queue'
  )
    throw fail();
  const expectedImages: Record<string, string> = expected.images;
  if (inventory.bindings.some((binding) => binding.imageId !== expectedImages[binding.key])) throw fail();
  inventory.images.sort((a, b) => (a.imageId < b.imageId ? -1 : a.imageId > b.imageId ? 1 : 0));
  inventory.bindings.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const entries: CorePayloadEntry[] = [
    { name: 'checkpoint.tar', ...expected.checkpoint },
    ...inventory.images.map((image) => ({ name: `images/${image.archive}`, bytes: image.bytes, sha256: image.sha256 })),
  ];
  const manifest: CorePayloadManifest = freeze({
    schema: 'orbis.time-machine-core.v1',
    pointId: expected.pointId,
    sourceSha256: expected.sourceSha256,
    checkpointSha256: expected.checkpointSha256,
    captureReceiptSha256: expected.captureReceiptSha256,
    imageInventorySha256: sha(canonicalCoreJson(inventory)),
    resourceCount: expected.resourceCount,
    compatibility: expected.compatibility,
    inventory,
    entries,
  });
  const metadata = Buffer.from(canonicalCoreJson(manifest));
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 12 + metadata.length);
  if (
    metadata.length > corePayloadLimits.manifestBytes ||
    !Number.isSafeInteger(bytes) ||
    bytes > backupGcmPlaintextLimit - corePayloadLimits.reserveBytes
  )
    throw fail();
  const directories = await Promise.all([...new Set([path.dirname(options.checkpointFile), options.imageDirectory])].map(privateDirectory));
  const names = [options.checkpointFile, ...inventory.images.map((image) => path.join(options.imageDirectory, image.archive))];
  const files: File[] = [];
  for (const [index, entry] of entries.entries()) {
    const file = names[index];
    if (!file) throw fail();
    const opened = await open(file, entry.bytes);
    try {
      await checksum(opened.handle, entry, options.signal);
      if (!same(opened.before, await opened.handle.stat()) || !same(opened.before, await fs.lstat(file))) throw fail();
      files.push({ file, entry, before: opened.before });
    } finally {
      await opened.handle.close();
    }
  }
  await verifyImages(inventory, files, expected.compatibility, options.signal);
  await recheck(files, directories);
  options.signal.throwIfAborted();
  const token = Object.freeze({}) as VerifiedCorePayload;
  capabilities.set(token, { manifest, metadata, bytes, files, directories });
  return token;
}
async function verifyImages(
  inventory: RetainedImageInventory,
  files: File[],
  compatibility: CorePayloadExpectation['compatibility'],
  signal: AbortSignal,
) {
  const paths = new Map(inventory.images.map((image, index) => [`image-capture/images/${image.archive}`, files[index + 1]?.file ?? '']));
  await verifyRetainedImageArchives({ inventory, files: paths, signal });
  for (const image of inventory.images) {
    const file = paths.get(`image-capture/images/${image.archive}`);
    if (!file) throw fail();
    await checkPlatform(file, image, compatibility, signal);
  }
}
async function recheck(files: File[], directories: Prepared['directories']) {
  for (const item of directories)
    if (!sameDirectory(item.before, await fs.lstat(item.file)) || (await fs.realpath(item.file)) !== item.file) throw fail();
  for (const item of files) if (!same(item.before, await fs.lstat(item.file)) || (await fs.realpath(item.file)) !== item.file) throw fail();
}
export async function withCorePayload<T>(
  token: VerifiedCorePayload,
  signal: AbortSignal,
  consume: (payload: { source: Readable; bytes: number; manifest: CorePayloadManifest; manifestSha256: string }) => Promise<T>,
): Promise<T> {
  const prepared = capabilities.get(token);
  if (!prepared) throw fail();
  capabilities.delete(token);
  signal.throwIfAborted();
  const opened: { handle: FileHandle; before: Stat }[] = [];
  let source: Readable | undefined;
  let completed = false;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  try {
    await recheck(prepared.files, prepared.directories);
    for (const item of prepared.files) {
      const descriptor = await open(item.file, item.entry.bytes);
      opened.push(descriptor);
      if (!same(item.before, descriptor.before)) throw fail();
      await checksum(descriptor.handle, item.entry, controller.signal);
    }
    await verifyImages(prepared.manifest.inventory, prepared.files, prepared.manifest.compatibility, controller.signal);
    await recheck(prepared.files, prepared.directories);
    controller.signal.throwIfAborted();
    source = Readable.from(
      (async function* () {
        const header = Buffer.alloc(12);
        header.write('ORBISCO1', 0, 'ascii');
        header.writeUInt32BE(prepared.metadata.length, 8);
        yield header;
        yield prepared.metadata;
        for (const [index, item] of prepared.files.entries()) {
          const descriptor = opened[index];
          if (!descriptor) throw fail();
          const sum = createHash('sha256');
          for await (const chunk of chunks(descriptor.handle, item.entry.bytes, controller.signal)) {
            sum.update(chunk);
            yield chunk;
          }
          if (sum.digest('hex') !== item.entry.sha256 || !same(item.before, await descriptor.handle.stat())) throw fail();
          await recheck(prepared.files, prepared.directories);
        }
        controller.signal.throwIfAborted();
        completed = true;
      })(),
      { objectMode: false, highWaterMark: corePayloadLimits.chunkBytes, signal: controller.signal },
    );
    const stream = source;
    const settled = finished(stream).catch(() => undefined);
    let cancel: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(controller.signal.reason ?? fail());
      controller.signal.addEventListener('abort', cancel, { once: true });
      if (controller.signal.aborted) cancel();
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() =>
          consume({
            source: stream,
            bytes: prepared.bytes,
            manifest: prepared.manifest,
            manifestSha256: sha(prepared.metadata),
          }),
        ),
        cancelled,
      ]);
      if (!completed || !stream.readableEnded) throw fail();
      await recheck(prepared.files, prepared.directories);
      for (const [index, descriptor] of opened.entries()) {
        const item = prepared.files[index];
        if (!item || !same(item.before, await descriptor.handle.stat())) throw fail();
      }
      controller.signal.throwIfAborted();
      return result;
    } finally {
      if (cancel) controller.signal.removeEventListener('abort', cancel);
      stream.destroy();
      await settled;
    }
  } finally {
    controller.abort();
    source?.destroy();
    signal.removeEventListener('abort', abort);
    await Promise.all(opened.map((item) => item.handle.close()));
  }
}
