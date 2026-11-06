import { createDecipheriv, createHash, scrypt, type DecipherGCM } from 'node:crypto';
import { constants } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { timeMachineLimits } from '@runtipi/common/schemas/time-machine';
import { backupGcmPlaintextLimit } from './backup-crypto';
import { validateRetainedImageInventory } from './backup-image-retention';
import {
  canonicalCoreJson,
  corePayloadLimits,
  prepareCorePayload,
  validateCorePayloadExpectation,
  type CorePayloadExpectation,
  type CorePayloadManifest,
} from './time-machine-core-payload';
import { TimeMachineStore } from './time-machine-store';

export type CoreSavedPointVerification = Readonly<{
  schema: 'orbis.core-capture-publication.v1';
  pointId: string;
  ownerId: number;
  createdAt: number;
  pointSha256: string;
  pointReservationSha256: string;
  metadataSha256: string;
  cipherBytes: number;
  cipherSha256: string;
  manifestSha256: string;
  imageInventorySha256: string;
  captureReceiptSha256: string;
  sourceSha256: string;
  checkpointSha256: string;
  checkpoint: Readonly<{ bytes: number; sha256: string }>;
  resourceCount: number;
  imageCount: number;
}>;
type Stat = Awaited<ReturnType<FileHandle['stat']>>;
type Identity = { file: string; before: Stat };
const fail = () => new Error('Saved core point could not be verified.');
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const same = (a: Stat, b: Stat) =>
  ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
const sameDirectory = (a: Stat, b: Stat) => ['dev', 'ino', 'mode', 'uid', 'gid'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
const owned = (stat: Stat) => typeof process.getuid === 'function' && stat.uid === process.getuid();
async function directory(file: string): Promise<Identity> {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || (await fs.realpath(file)) !== file) throw fail();
  const before = await fs.lstat(file);
  if (!before.isDirectory() || !owned(before) || (before.mode & 0o7777) !== 0o700) throw fail();
  return { file, before };
}
async function recheckDirectory(item: Identity) {
  if (!sameDirectory(item.before, await fs.lstat(item.file)) || (await fs.realpath(item.file)) !== item.file) throw fail();
}
async function identity(file: string): Promise<Identity> {
  if ((await fs.realpath(file)) !== file) throw fail();
  const before = await fs.lstat(file);
  if (!before.isFile() || !owned(before) || before.nlink !== 1 || ![0o400, 0o600].includes(before.mode & 0o7777)) throw fail();
  return { file, before };
}
async function recheck(item: Identity) {
  if (!same(item.before, await fs.lstat(item.file)) || (await fs.realpath(item.file)) !== item.file) throw fail();
}
async function stagingContents(stage: Identity, images: Identity, files: Identity[]) {
  await recheckDirectory(stage);
  await recheckDirectory(images);
  const names = files.map((item) => path.relative(stage.file, item.file)).sort();
  const actual = [
    ...(await fs.readdir(stage.file)).filter((name) => name !== 'images'),
    ...(await fs.readdir(images.file)).map((name) => `images/${name}`),
  ].sort();
  if (canonicalCoreJson(names) !== canonicalCoreJson(actual)) throw fail();
  for (const item of files) await recheck(item);
}
async function bounded(file: string, maximum: number, signal: AbortSignal) {
  const item = await identity(file);
  if (item.before.size < 1 || item.before.size > maximum) throw fail();
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(item.before, await handle.stat())) throw fail();
    const data = Buffer.alloc(Number(item.before.size));
    let offset = 0;
    while (offset < data.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(data, offset, Math.min(corePayloadLimits.chunkBytes, data.length - offset), offset);
      if (!bytesRead) throw fail();
      offset += bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, data.length)).bytesRead || !same(item.before, await handle.stat())) throw fail();
    await recheck(item);
    return { ...item, data };
  } finally {
    await handle.close();
  }
}
function manifestFrom(data: Buffer, expected: CorePayloadExpectation): CorePayloadManifest {
  const value = JSON.parse(data.toString('utf8'));
  const inventory = validateRetainedImageInventory(value?.inventory);
  if (
    inventory.images.length < 1 ||
    inventory.images.length > 3 ||
    inventory.bindings.length !== 3 ||
    inventory.bindings
      .map((item) => item.key)
      .sort()
      .join(',') !== 'controller,database,queue' ||
    inventory.bindings.some((item) => item.imageId !== Reflect.get(expected.images, item.key))
  )
    throw fail();
  inventory.images.sort((a, b) => (a.imageId < b.imageId ? -1 : a.imageId > b.imageId ? 1 : 0));
  inventory.bindings.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const manifest: CorePayloadManifest = {
    schema: 'orbis.time-machine-core.v1',
    pointId: expected.pointId,
    sourceSha256: expected.sourceSha256,
    checkpointSha256: expected.checkpointSha256,
    captureReceiptSha256: expected.captureReceiptSha256,
    resourceCount: expected.resourceCount,
    compatibility: expected.compatibility,
    inventory,
    imageInventorySha256: sha(canonicalCoreJson(inventory)),
    entries: [
      { name: 'checkpoint.tar', ...expected.checkpoint },
      ...inventory.images.map((image) => ({ name: `images/${image.archive}`, bytes: image.bytes, sha256: image.sha256 })),
    ],
  };
  const bytes = manifest.entries.reduce((sum, entry) => sum + entry.bytes, 12 + data.length);
  if (
    !data.equals(Buffer.from(canonicalCoreJson(manifest))) ||
    !Number.isSafeInteger(bytes) ||
    bytes > backupGcmPlaintextLimit - corePayloadLimits.reserveBytes
  )
    throw fail();
  return manifest;
}
async function* decrypt(source: Readable, passphrase: string, signal: AbortSignal) {
  let header = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let key: Buffer | undefined;
  let cipher: DecipherGCM | undefined;
  let received = 0;
  try {
    for await (const raw of source) {
      const input = Buffer.from(raw);
      for (let offset = 0; offset < input.length; offset += corePayloadLimits.chunkBytes) {
        signal.throwIfAborted();
        let chunk = input.subarray(offset, offset + corePayloadLimits.chunkBytes);
        received += chunk.length;
        if (received > backupGcmPlaintextLimit + 52) throw fail();
        if (header.length < 36) {
          const count = Math.min(36 - header.length, chunk.length);
          header = Buffer.concat([header, chunk.subarray(0, count)]);
          chunk = chunk.subarray(count);
          if (header.length < 36) continue;
          if (!header.subarray(0, 8).equals(Buffer.from('ORBISBK1'))) throw fail();
          key = await new Promise<Buffer>((resolve, reject) => {
            scrypt(passphrase, header.subarray(8, 24), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) =>
              error ? reject(error) : resolve(derived),
            );
          });
          signal.throwIfAborted();
          cipher = createDecipheriv('aes-256-gcm', key, header.subarray(24));
          cipher.setAAD(header);
        }
        const pending = Buffer.concat([tail, chunk]);
        const end = Math.max(0, pending.length - 16);
        tail = Buffer.from(pending.subarray(end));
        if (end) yield (cipher as DecipherGCM).update(pending.subarray(0, end));
      }
    }
    signal.throwIfAborted();
    if (!cipher || received < 52 || tail.length !== 16) throw fail();
    cipher.setAuthTag(tail);
    yield cipher.final();
  } finally {
    key?.fill(0);
  }
}

/** Data verification only. The independent root caller must establish invocation,
 * enrolled-controller identity and settled-receipt authority before using this descriptor. */
async function checkCoreSavedPoint(options: {
  dataDir: string;
  expectation: CorePayloadExpectation;
  stagingDirectory: string;
  signal: AbortSignal;
}): Promise<CoreSavedPointVerification> {
  const { signal } = options;
  signal.throwIfAborted();
  const expected = validateCorePayloadExpectation(options.expectation);
  if (
    !path.isAbsolute(options.dataDir) ||
    path.resolve(options.dataDir) !== options.dataDir ||
    (await fs.realpath(options.dataDir)) !== options.dataDir
  )
    throw fail();
  const store = new TimeMachineStore(options.dataDir);
  const pointDirectory = path.join(options.dataDir, 'backups/time-machine/points', expected.pointId);
  const pointParent = await directory(pointDirectory);
  const rawPoint = await bounded(path.join(pointDirectory, 'point.json'), 32768, signal);
  const point = await store.load(expected.pointId);
  if (
    canonicalCoreJson(JSON.parse(rawPoint.data.toString('utf8'))) !== canonicalCoreJson(point) ||
    point.version !== 3 ||
    point.status !== 'sealed' ||
    point.backupJobId !== null ||
    point.issue !== null ||
    !point.core ||
    !point.metadataSha256 ||
    !point.archiveSha256
  )
    throw fail();
  const rawMetadata = await bounded(path.join(pointDirectory, 'metadata.orbis'), timeMachineLimits.metadataBytes + 52, signal);
  if (sha(rawMetadata.data) !== point.metadataSha256) throw fail();
  const metadata = await store.metadata(point);
  if (
    metadata.version !== 3 ||
    canonicalCoreJson(metadata.compatibility) !== canonicalCoreJson(expected.compatibility) ||
    metadata.core.sourceSha256 !== expected.sourceSha256 ||
    metadata.core.checkpointSha256 !== expected.checkpointSha256 ||
    metadata.core.captureReceiptSha256 !== expected.captureReceiptSha256 ||
    metadata.core.resourceCount !== expected.resourceCount ||
    metadata.core.imageCount !== new Set(Object.values(expected.images)).size
  )
    throw fail();
  const archive = await identity(path.join(pointDirectory, 'core.orbis'));
  const parent = await directory(options.stagingDirectory);
  let stage: Identity | undefined;
  let images: Identity | undefined;
  const files: Identity[] = [];
  let output: FileHandle | undefined;
  let outputFile: string | undefined;
  try {
    const root = await fs.mkdtemp(path.join(parent.file, 'core-saved-point-'));
    stage = await directory(root);
    await recheckDirectory(parent);
    await fs.mkdir(path.join(root, 'images'), { mode: 0o700 });
    images = await directory(path.join(root, 'images'));
    let manifest: CorePayloadManifest | undefined;
    let prefix = Buffer.alloc(0);
    let manifestData = Buffer.alloc(0);
    let manifestBytes = 0;
    let index = 0;
    let entryBytes = 0;
    let digest = createHash('sha256');
    await store.withArchive(point, signal, async (source, passphrase) => {
      for await (const plaintext of decrypt(source, passphrase, signal)) {
        let chunk = plaintext;
        while (chunk.length) {
          signal.throwIfAborted();
          if (prefix.length < 12) {
            const count = Math.min(12 - prefix.length, chunk.length);
            prefix = Buffer.concat([prefix, chunk.subarray(0, count)]);
            chunk = chunk.subarray(count);
            if (prefix.length < 12) continue;
            manifestBytes = prefix.readUInt32BE(8);
            if (!prefix.subarray(0, 8).equals(Buffer.from('ORBISCO1')) || manifestBytes < 1 || manifestBytes > corePayloadLimits.manifestBytes)
              throw fail();
          }
          if (!manifest) {
            const count = Math.min(manifestBytes - manifestData.length, chunk.length);
            manifestData = Buffer.concat([manifestData, chunk.subarray(0, count)]);
            chunk = chunk.subarray(count);
            if (manifestData.length < manifestBytes) continue;
            manifest = manifestFrom(manifestData, expected);
            if (
              sha(manifestData) !== metadata.core.manifestSha256 ||
              manifest.imageInventorySha256 !== metadata.core.imageInventorySha256 ||
              manifest.inventory.images.length !== metadata.core.imageCount
            )
              throw fail();
          }
          if (!chunk.length) continue;
          const entry = manifest.entries[index];
          if (!entry) throw fail();
          if (!output) {
            outputFile = path.join(root, entry.name);
            output = await fs.open(outputFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          }
          const count = Math.min(chunk.length, entry.bytes - entryBytes, corePayloadLimits.chunkBytes);
          let written = 0;
          while (written < count) {
            signal.throwIfAborted();
            const result = await output.write(chunk, written, count - written);
            if (!result.bytesWritten) throw fail();
            written += result.bytesWritten;
          }
          digest.update(chunk.subarray(0, count));
          entryBytes += count;
          chunk = chunk.subarray(count);
          if (entryBytes === entry.bytes) {
            if (digest.digest('hex') !== entry.sha256) throw fail();
            await output.sync();
            files.push({ file: outputFile as string, before: await output.stat() });
            await output.close();
            output = undefined;
            outputFile = undefined;
            digest = createHash('sha256');
            entryBytes = 0;
            index++;
          }
        }
      }
      if (!manifest || index !== manifest.entries.length || output || entryBytes) throw fail();
    });
    if (!manifest) throw fail();
    // This capability is discarded; it grants no publication or recovery authority.
    await prepareCorePayload({
      expectation: expected,
      checkpointFile: path.join(root, 'checkpoint.tar'),
      imageInventory: manifest.inventory,
      imageDirectory: images.file,
      signal,
    });
    await recheckDirectory(parent);
    await stagingContents(stage, images, files);
    await recheckDirectory(pointParent);
    for (const item of [rawPoint, rawMetadata, archive]) await recheck(item);
    if (
      canonicalCoreJson(await store.load(point.id)) !== canonicalCoreJson(point) ||
      canonicalCoreJson(await store.metadata(point)) !== canonicalCoreJson(metadata)
    )
      throw fail();
    for (const item of [rawPoint, rawMetadata, archive]) await recheck(item);
    await recheckDirectory(pointParent);
    signal.throwIfAborted();
    return Object.freeze({
      schema: 'orbis.core-capture-publication.v1',
      pointId: point.id,
      ownerId: point.ownerId,
      createdAt: point.createdAt,
      pointSha256: sha(rawPoint.data),
      metadataSha256: point.metadataSha256,
      cipherBytes: point.archiveBytes,
      cipherSha256: point.archiveSha256,
      pointReservationSha256: sha(
        canonicalCoreJson({ version: point.version, id: point.id, ownerId: point.ownerId, createdAt: point.createdAt, envelope: point.envelope }),
      ),
      manifestSha256: metadata.core.manifestSha256,
      imageInventorySha256: metadata.core.imageInventorySha256,
      captureReceiptSha256: expected.captureReceiptSha256,
      sourceSha256: expected.sourceSha256,
      checkpointSha256: expected.checkpointSha256,
      checkpoint: Object.freeze({ ...expected.checkpoint }),
      resourceCount: expected.resourceCount,
      imageCount: manifest.inventory.images.length,
    });
  } catch {
    throw fail();
  } finally {
    if (output) {
      // Record only our still-open inode, never a replacement at its pathname.
      if (outputFile) files.push({ file: outputFile, before: await output.stat() });
      await output.close();
    }
    if (stage && images) {
      try {
        await recheckDirectory(parent);
        await stagingContents(stage, images, files);
        for (const item of files) await fs.unlink(item.file);
        await fs.rmdir(images.file);
        await fs.rmdir(stage.file);
      } catch {
        /* Preserve ambiguous staging for independent reconciliation. */
      }
    }
  }
}

export async function verifyCoreSavedPoint(options: {
  dataDir: string;
  expectation: CorePayloadExpectation;
  stagingDirectory: string;
  signal: AbortSignal;
}): Promise<CoreSavedPointVerification> {
  try {
    return await checkCoreSavedPoint(options);
  } catch {
    throw fail();
  }
}
