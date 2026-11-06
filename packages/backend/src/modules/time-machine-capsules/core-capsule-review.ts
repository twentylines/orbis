import { createDecipheriv, createHash, scrypt } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { timeMachineCoreMetadataSchema, type TimeMachineCoreMetadata } from '@runtipi/common/schemas/time-machine';
import { backupMetadataBytes } from '../system-backups/backup-crypto';
import { validateRetainedImageInventory } from '../system-backups/backup-image-retention';
import {
  canonicalCoreJson,
  corePayloadLimits,
  prepareCorePayload,
  validateCorePayloadExpectation,
  withCorePayload,
  type CorePayloadManifest,
} from '../system-backups/time-machine-core-payload';
import { capsuleLimits, capsuleManifestSchema, type CapsuleEntry, type CapsuleManifest } from './capsule';
import { verifyCapsulePreview } from './capsule-preview';
import { capsuleDirectorySeal, inspectCapsuleEntry, readCapsuleEntry, sameCapsuleDirectorySeal, sameCapsuleSeal } from './verified-source';

const fail = () => new Error('The core capsule did not pass read-only verification. Destination enrollment is still required.');
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
export type CoreCapsuleReview = {
  summary: Readonly<{ pointId: string; createdAt: number; sourceOwnerId: number; metadata: TimeMachineCoreMetadata; restoreSupported: false }>;
  recheck: (signal: AbortSignal) => Promise<void>;
};
async function json(directory: string, manifest: CapsuleManifest, name: 'metadata.orbis' | 'capture-draft.orbis', signal: AbortSignal) {
  const entry = manifest.entries.find((entry) => entry.name === name);
  if (!entry) throw fail();
  const ciphertext = await readCapsuleEntry(directory, entry, signal, capsuleLimits.manifestBytes + 52);
  const plaintext = await backupMetadataBytes(ciphertext, manifest.pointKey, true, capsuleLimits.manifestBytes);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as unknown;
  } finally {
    plaintext.fill(0);
  }
}
async function read(handle: FileHandle, count: number, position: number, signal: AbortSignal) {
  const result = Buffer.alloc(count);
  let offset = 0;
  while (offset < count) {
    signal.throwIfAborted();
    const { bytesRead } = await handle.read(result, offset, count - offset, position + offset);
    if (!bytesRead) throw fail();
    offset += bytesRead;
  }
  return result;
}
async function decryptPinnedCore(
  directory: string,
  entry: CapsuleEntry,
  expected: Awaited<ReturnType<FileHandle['stat']>>,
  output: FileHandle,
  pointKey: string,
  signal: AbortSignal,
) {
  const file = path.join(directory, entry.name);
  const input = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let key: Buffer | undefined;
  try {
    const before = await input.stat();
    if (!sameCapsuleSeal(expected, before) || !sameCapsuleSeal(before, await fs.lstat(file))) throw fail();
    const header = await read(input, 36, 0, signal);
    if (!header.subarray(0, 8).equals(Buffer.from('ORBISBK1'))) throw fail();
    key = await new Promise<Buffer>((resolve, reject) => {
      scrypt(pointKey, header.subarray(8, 24), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) =>
        error ? reject(error) : resolve(derived),
      );
    });
    signal.throwIfAborted();
    const cipher = createDecipheriv('aes-256-gcm', key, header.subarray(24));
    cipher.setAAD(header);
    const tag = await read(input, 16, before.size - 16, signal);
    cipher.setAuthTag(tag);
    const digest = createHash('sha256').update(header);
    const write = async (value: Buffer) => {
      let offset = 0;
      while (offset < value.length) {
        signal.throwIfAborted();
        const { bytesWritten } = await output.write(value, offset, value.length - offset);
        if (!bytesWritten) throw fail();
        offset += bytesWritten;
      }
    };
    for (let position = 36; position < before.size - 16; ) {
      const chunk = await read(input, Math.min(corePayloadLimits.chunkBytes, before.size - 16 - position), position, signal);
      digest.update(chunk);
      await write(cipher.update(chunk));
      position += chunk.length;
    }
    await write(cipher.final());
    if (
      digest.update(tag).digest('hex') !== entry.sha256 ||
      !sameCapsuleSeal(before, await input.stat()) ||
      !sameCapsuleSeal(before, await fs.lstat(file))
    )
      throw fail();
    await output.sync();
    signal.throwIfAborted();
  } finally {
    key?.fill(0);
    await input.close();
  }
}
function payloadManifest(value: unknown, encoded: Buffer, metadata: TimeMachineCoreMetadata): CorePayloadManifest {
  if (
    !exact(value, [
      'schema',
      'pointId',
      'sourceSha256',
      'checkpointSha256',
      'captureReceiptSha256',
      'resourceCount',
      'compatibility',
      'inventory',
      'imageInventorySha256',
      'entries',
    ]) ||
    !Array.isArray(value.entries)
  )
    throw fail();
  const inventory = validateRetainedImageInventory(value.inventory);
  inventory.images.sort((a, b) => a.imageId.localeCompare(b.imageId));
  inventory.bindings.sort((a, b) => a.key.localeCompare(b.key));
  const checkpoint = value.entries[0] as unknown;
  if (!exact(checkpoint, ['name', 'bytes', 'sha256']) || checkpoint.name !== 'checkpoint.tar') throw fail();
  const bindings = Object.fromEntries(inventory.bindings.map((binding) => [binding.key, binding.imageId]));
  const expected = validateCorePayloadExpectation({
    pointId: metadata.id,
    sourceSha256: metadata.core.sourceSha256,
    checkpointSha256: metadata.core.checkpointSha256,
    captureReceiptSha256: metadata.core.captureReceiptSha256,
    resourceCount: metadata.core.resourceCount,
    compatibility: metadata.compatibility,
    images: bindings,
    checkpoint: { bytes: checkpoint.bytes, sha256: checkpoint.sha256 },
  });
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
  if (
    !encoded.equals(Buffer.from(canonicalCoreJson(manifest))) ||
    sha(encoded) !== metadata.core.manifestSha256 ||
    manifest.imageInventorySha256 !== metadata.core.imageInventorySha256 ||
    inventory.images.length !== metadata.core.imageCount
  )
    throw fail();
  return manifest;
}
/** Authenticates captured data and retained images. It does not establish root receipt, enrollment or host-operation authority. */
export async function reviewCoreCapsule(options: {
  directory: string;
  manifest: Extract<CapsuleManifest, { schema: 'orbis.time-machine-capsule-private.v2' }>;
  signal: AbortSignal;
}): Promise<CoreCapsuleReview> {
  const { directory, signal } = options;
  const manifest = capsuleManifestSchema.assert(structuredClone(options.manifest));
  if (
    manifest.schema !== 'orbis.time-machine-capsule-private.v2' ||
    !Number.isSafeInteger(manifest.sourceOwnerId) ||
    !Number.isSafeInteger(manifest.createdAt) ||
    manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0) > capsuleLimits.bytes
  )
    throw fail();
  const original = await capsuleDirectorySeal(directory);
  const seals = await Promise.all(manifest.entries.map((entry) => inspectCapsuleEntry(directory, entry, signal)));
  const names = manifest.entries
    .map((entry) => entry.name)
    .sort()
    .join(',');
  const recheck = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!sameCapsuleDirectorySeal(original, await capsuleDirectorySeal(directory)) || (await fs.readdir(directory)).sort().join(',') !== names)
      throw fail();
    for (const [index, entry] of manifest.entries.entries()) await inspectCapsuleEntry(directory, entry, signal, seals[index]);
    if (!sameCapsuleDirectorySeal(original, await capsuleDirectorySeal(directory)) || (await fs.readdir(directory)).sort().join(',') !== names)
      throw fail();
  };
  const metadata = timeMachineCoreMetadataSchema.assert(await json(directory, manifest, 'metadata.orbis', signal));
  const core = manifest.entries[0];
  if (
    !core ||
    metadata.id !== manifest.pointId ||
    metadata.createdAt !== manifest.createdAt ||
    metadata.archiveBytes !== core.bytes ||
    metadata.archiveSha256 !== core.sha256
  )
    throw fail();
  const savedDraft = await json(directory, manifest, 'capture-draft.orbis', signal);
  const { archiveBytes: _bytes, archiveSha256: _archive, manifestSha256: _manifest, core: _core, ...draft } = metadata;
  if (
    !exact(savedDraft, ['binding', 'draft', 'version']) ||
    savedDraft.version !== 1 ||
    !exact(savedDraft.binding, ['id', 'ownerId', 'createdAt', 'envelope']) ||
    savedDraft.binding.id !== manifest.pointId ||
    savedDraft.binding.ownerId !== manifest.sourceOwnerId ||
    savedDraft.binding.createdAt !== manifest.createdAt ||
    canonicalCoreJson(savedDraft.draft) !== canonicalCoreJson(draft)
  )
    throw fail();
  const envelope = savedDraft.binding.envelope;
  if (
    !exact(envelope, ['version', 'keyId', 'nonce', 'tag', 'value']) ||
    envelope.version !== 1 ||
    typeof envelope.keyId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(envelope.keyId) ||
    typeof envelope.nonce !== 'string' ||
    !/^[a-f0-9]{24}$/.test(envelope.nonce) ||
    typeof envelope.tag !== 'string' ||
    !/^[a-f0-9]{32}$/.test(envelope.tag) ||
    typeof envelope.value !== 'string' ||
    !/^[a-f0-9]{86}$/.test(envelope.value)
  )
    throw fail();
  await verifyCapsulePreview(metadata, manifest, directory, signal);
  const space = await fs.statfs(directory, { bigint: true });
  if (space.bavail * space.bsize < BigInt(core.bytes * 2 + capsuleLimits.reserveBytes)) throw fail();
  await recheck(signal);
  const stage = await fs.mkdtemp(path.join(directory, 'core-review-'));
  await fs.chmod(stage, 0o700);
  const stageSeal = await capsuleDirectorySeal(stage);
  const generated: { file: string; seal: Awaited<ReturnType<FileHandle['stat']>> }[] = [];
  let imageDirectorySeal: Awaited<ReturnType<FileHandle['stat']>> | undefined;
  const cleanup = async () => {
    // Remove only generated files whose identities still match our open descriptors.
    if (sameCapsuleDirectorySeal(stageSeal, await capsuleDirectorySeal(stage))) {
      if (imageDirectorySeal && !sameCapsuleDirectorySeal(imageDirectorySeal, await capsuleDirectorySeal(path.join(stage, 'images')))) throw fail();
      for (const item of generated) if (!sameCapsuleSeal(item.seal, await fs.lstat(item.file))) throw fail();
      for (const item of generated) await fs.unlink(item.file);
      if (imageDirectorySeal) await fs.rmdir(path.join(stage, 'images'));
      await fs.rmdir(stage);
    } else throw fail();
  };
  let input: FileHandle | undefined;
  try {
    const plain = path.join(stage, 'payload');
    input = await fs.open(plain, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const coreSeal = seals[0];
    if (!coreSeal) throw fail();
    try {
      await decryptPinnedCore(directory, core, coreSeal, input, manifest.pointKey, signal);
    } finally {
      generated.push({ file: plain, seal: await input.stat() });
    }
    const before = await input.stat();
    if (before.size !== core.bytes - 52) throw fail();
    const prefix = await read(input, 12, 0, signal);
    const size = prefix.readUInt32BE(8);
    if (!prefix.subarray(0, 8).equals(Buffer.from('ORBISCO1')) || size < 1 || size > corePayloadLimits.manifestBytes) throw fail();
    const encoded = await read(input, size, 12, signal);
    const payload = payloadManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded)), encoded, metadata);
    await fs.mkdir(path.join(stage, 'images'), { mode: 0o700 });
    imageDirectorySeal = await capsuleDirectorySeal(path.join(stage, 'images'));
    let position = 12 + size;
    for (const entry of payload.entries) {
      const file = path.join(stage, entry.name);
      const output = await fs.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        let remaining = entry.bytes;
        const digest = createHash('sha256');
        while (remaining) {
          const chunk = await read(input, Math.min(remaining, corePayloadLimits.chunkBytes), position, signal);
          let offset = 0;
          while (offset < chunk.length) {
            signal.throwIfAborted();
            const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
            if (!bytesWritten) throw fail();
            offset += bytesWritten;
          }
          digest.update(chunk);
          remaining -= chunk.length;
          position += chunk.length;
        }
        if (digest.digest('hex') !== entry.sha256) throw fail();
        await output.sync();
      } finally {
        generated.push({ file, seal: await output.stat() });
        await output.close();
      }
    }
    if (position !== before.size || !sameCapsuleSeal(before, await input.stat()) || !sameCapsuleSeal(before, await fs.lstat(plain))) throw fail();
    const checkpoint = payload.entries[0];
    if (!checkpoint) throw fail();
    const expected = validateCorePayloadExpectation({
      pointId: payload.pointId,
      sourceSha256: payload.sourceSha256,
      checkpointSha256: payload.checkpointSha256,
      captureReceiptSha256: payload.captureReceiptSha256,
      resourceCount: payload.resourceCount,
      compatibility: payload.compatibility,
      images: Object.fromEntries(payload.inventory.bindings.map((binding) => [binding.key, binding.imageId])),
      checkpoint: { bytes: checkpoint.bytes, sha256: checkpoint.sha256 },
    });
    const token = await prepareCorePayload({
      expectation: expected,
      checkpointFile: path.join(stage, 'checkpoint.tar'),
      imageInventory: payload.inventory,
      imageDirectory: path.join(stage, 'images'),
      signal,
    });
    await withCorePayload(token, signal, async (value) => {
      if (
        canonicalCoreJson(value.manifest) !== canonicalCoreJson(payload) ||
        value.manifestSha256 !== metadata.core.manifestSha256 ||
        value.bytes !== before.size
      )
        throw fail();
      for await (const _chunk of value.source) signal.throwIfAborted();
    });
  } finally {
    await input?.close();
    await cleanup();
  }
  await recheck(signal);
  return {
    summary: Object.freeze({
      pointId: metadata.id,
      createdAt: metadata.createdAt,
      sourceOwnerId: manifest.sourceOwnerId,
      metadata,
      restoreSupported: false,
    }),
    recheck,
  };
}
