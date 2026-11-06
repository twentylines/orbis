import { historicalIconLimits } from '@runtipi/common/schemas/time-machine-icons';
import { createHash, randomUUID } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type } from 'arktype';
import {
  backupCipherOverhead,
  backupGcmPlaintextLimit,
  backupMetadataBytes,
  decryptBackup,
  encryptBackupStream,
} from '../system-backups/backup-crypto';
import { privateBackupDirectory } from '../system-backups/backup-files';

export const capsuleLimits = {
  bytes: 128 * 1024 ** 3,
  segmentBytes: 1024 ** 3,
  segments: 160,
  manifestBytes: 2 * 1024 ** 2,
  reserveBytes: 256 * 1024 ** 2,
} as const;
const magic = Buffer.from('ORBISCP1');
const segmentMagic = Buffer.from('ORBCSEG1');
const prefixBytes = 64;
const frameBytes = 44;
const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const id = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const entry = type({
  '+': 'reject',
  name: "'backup.orbis' | 'runtime.orbis' | 'core.orbis' | 'capture-draft.orbis' | 'metadata.orbis' | 'wallpaper.orbis' | 'icons.orbis'",
  bytes: `52 <= number.integer <= ${backupGcmPlaintextLimit + backupCipherOverhead}`,
  sha256: hash,
});
const headerSchema = type({
  '+': 'reject',
  schema: "'orbis.time-machine-capsule.v1' | 'orbis.time-machine-capsule.v2'",
  capsuleId: id,
  segmentBytes: `1024 <= number.integer <= ${capsuleLimits.segmentBytes}`,
  segments: `1 <= number.integer <= ${capsuleLimits.segments}`,
  payloadBytes: `1 <= number.integer <= ${capsuleLimits.bytes}`,
  manifestBytes: `52 <= number.integer <= ${capsuleLimits.manifestBytes + backupCipherOverhead}`,
  manifestSha256: hash,
}).narrow((value) => value.segments === Math.ceil(value.payloadBytes / value.segmentBytes));
const manifestBase = type({
  '+': 'reject',
  schema: "'orbis.time-machine-capsule-private.v1'",
  capsuleId: id,
  pointId: id,
  createdAt: 'number.integer > 0',
  pointKey: type('string').narrow((value) => /^[A-Za-z0-9_-]{43}$/.test(value)),
  entries: entry.array().atLeastLength(3).atMostLength(5),
});
const legacyManifestSchema = manifestBase.narrow((value) => {
  const names = value.entries.map((entry) => entry.name).join(',');
  return [
    'backup.orbis,runtime.orbis,metadata.orbis',
    'backup.orbis,runtime.orbis,metadata.orbis,wallpaper.orbis',
    'backup.orbis,runtime.orbis,metadata.orbis,icons.orbis',
    'backup.orbis,runtime.orbis,metadata.orbis,wallpaper.orbis,icons.orbis',
  ].includes(names);
});
const coreManifestSchema = manifestBase
  .omit('schema')
  .merge({ schema: "'orbis.time-machine-capsule-private.v2'", sourceOwnerId: 'number.integer > 0' })
  .narrow((value) => {
    const names = value.entries.map((entry) => entry.name).join(',');
    return [
      'core.orbis,capture-draft.orbis,metadata.orbis',
      'core.orbis,capture-draft.orbis,metadata.orbis,wallpaper.orbis',
      'core.orbis,capture-draft.orbis,metadata.orbis,icons.orbis',
      'core.orbis,capture-draft.orbis,metadata.orbis,wallpaper.orbis,icons.orbis',
    ].includes(names);
  });
export const capsuleManifestSchema = legacyManifestSchema.or(coreManifestSchema);
export type CapsuleEntry = typeof entry.infer;
export type CapsuleManifest = typeof capsuleManifestSchema.infer;
export type CapsuleHeader = typeof headerSchema.infer;
export type CapsuleSource = CapsuleEntry & ({ file: string; source?: never } | { source: Readable; file?: never });
const fail = () => new Error('The Time Machine capsule could not be verified. No server state was replaced.');
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const canonicalHeader = (value: CapsuleHeader) =>
  JSON.stringify(Object.fromEntries(Object.entries(value).sort(([first], [second]) => first.localeCompare(second))));
const same = (a: Awaited<ReturnType<FileHandle['stat']>>, b: Awaited<ReturnType<FileHandle['stat']>>) =>
  ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'nlink', 'uid'].every((key) => Reflect.get(a, key) === Reflect.get(b, key));
async function write(file: FileHandle, bytes: Buffer) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset);
    if (!result.bytesWritten) throw fail();
    offset += result.bytesWritten;
  }
}
async function read(file: FileHandle, bytes: number, position: number) {
  const data = Buffer.alloc(bytes);
  let offset = 0;
  while (offset < bytes) {
    const result = await file.read(data, offset, bytes - offset, position + offset);
    if (!result.bytesRead) throw fail();
    offset += result.bytesRead;
  }
  return data;
}
async function sync(directory: string) {
  const file = await fs.open(directory, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
async function safeFile(file: string, maximum: number) {
  const parent = path.dirname(file);
  const directory = await fs.lstat(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077 || (await fs.realpath(parent)) !== path.resolve(parent))
    throw fail();
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > maximum || (process.getuid && stat.uid !== process.getuid()))
      throw fail();
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
function segmentPrefix(header: CapsuleHeader, index: number) {
  const result = Buffer.alloc(prefixBytes);
  segmentMagic.copy(result);
  Buffer.from(header.capsuleId.replaceAll('-', ''), 'hex').copy(result, 8);
  result.writeUInt32BE(index, 24);
  result.writeUInt32BE(header.segments, 28);
  Buffer.from(header.manifestSha256, 'hex').copy(result, 32);
  return result;
}
function validateEntries(entries: CapsuleEntry[]) {
  if (entries.reduce((total, item) => total + item.bytes, 0) > capsuleLimits.bytes) throw fail();
  if (
    (entries.find((entry) => entry.name === 'metadata.orbis')?.bytes ?? Number.POSITIVE_INFINITY) >
    capsuleLimits.manifestBytes + backupCipherOverhead
  )
    throw fail();
  if ((entries.find((entry) => entry.name === 'capture-draft.orbis')?.bytes ?? 0) > capsuleLimits.manifestBytes + backupCipherOverhead) throw fail();
  if ((entries.find((entry) => entry.name === 'icons.orbis')?.bytes ?? 0) > historicalIconLimits.bundleBytes + backupCipherOverhead) throw fail();
  if ((entries.find((entry) => entry.name === 'wallpaper.orbis')?.bytes ?? 0) > 32 * 1024 ** 2 + backupCipherOverhead) throw fail();
}
async function* sourceBytes(sources: CapsuleSource[], signal: AbortSignal) {
  for (const source of sources) {
    signal.throwIfAborted();
    const pinned = source.file ? await safeFile(source.file, source.bytes) : null;
    const stream = pinned ? pinned.handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, signal }) : source.source;
    if (!stream || (pinned && pinned.stat.size !== source.bytes)) {
      await pinned?.handle.close();
      throw fail();
    }
    let received = 0;
    const digest = createHash('sha256');
    try {
      for await (const raw of stream) {
        signal.throwIfAborted();
        const chunk = Buffer.from(raw);
        received += chunk.length;
        if (received > source.bytes) throw fail();
        digest.update(chunk);
        yield chunk;
      }
      if (received !== source.bytes || digest.digest('hex') !== source.sha256 || (pinned && !same(pinned.stat, await pinned.handle.stat())))
        throw fail();
    } finally {
      if (pinned || !stream.readableEnded) stream.destroy();
      await pinned?.handle.close();
    }
  }
}
class Cursor {
  private pending: Buffer = Buffer.alloc(0);
  constructor(private readonly iterator: AsyncIterator<Buffer>) {}
  async *take(bytes: number) {
    let remaining = bytes;
    while (remaining) {
      if (!this.pending.length) {
        const next = await this.iterator.next();
        if (next.done) throw fail();
        this.pending = next.value;
      }
      const count = Math.min(remaining, this.pending.length);
      yield this.pending.subarray(0, count);
      this.pending = this.pending.subarray(count);
      remaining -= count;
    }
  }
  async finish() {
    if (this.pending.length || !(await this.iterator.next()).done) throw fail();
  }
  async close() {
    await this.iterator.return?.();
  }
}

/** Exports exact inner ciphers; the point key exists only in the encrypted private manifest and process memory. */
export async function exportCapsule(options: {
  destination: string;
  pointId: string;
  createdAt: number;
  pointKey: string;
  sourceOwnerId?: number;
  entries: CapsuleSource[];
  passphrase: string;
  signal: AbortSignal;
  segmentBytes?: number;
  progress?: (complete: number, total: number) => void;
}) {
  const directory = path.dirname(options.destination);
  await privateBackupDirectory(directory);
  const capsuleId = randomUUID();
  const entries = options.entries.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }));
  const core = entries[0]?.name === 'core.orbis';
  const manifest = capsuleManifestSchema.assert({
    schema: core ? 'orbis.time-machine-capsule-private.v2' : 'orbis.time-machine-capsule-private.v1',
    ...(core ? { sourceOwnerId: options.sourceOwnerId } : {}),
    capsuleId,
    pointId: options.pointId,
    createdAt: options.createdAt,
    pointKey: options.pointKey,
    entries,
  });
  validateEntries(entries);
  const payloadBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const segmentBytes = options.segmentBytes ?? capsuleLimits.segmentBytes;
  let privateBytes = Buffer.from(JSON.stringify(manifest));
  let encryptedManifest: Buffer;
  try {
    encryptedManifest = await backupMetadataBytes(privateBytes, options.passphrase, false, capsuleLimits.manifestBytes);
  } finally {
    privateBytes.fill(0);
    privateBytes = Buffer.alloc(0);
  }
  const header = headerSchema.assert({
    schema: core ? 'orbis.time-machine-capsule.v2' : 'orbis.time-machine-capsule.v1',
    capsuleId,
    segmentBytes,
    segments: Math.ceil(payloadBytes / segmentBytes),
    payloadBytes,
    manifestBytes: encryptedManifest.length,
    manifestSha256: sha(encryptedManifest),
  });
  const headerBytes = Buffer.from(canonicalHeader(header));
  const start = Buffer.alloc(12);
  magic.copy(start);
  start.writeUInt32BE(headerBytes.length, 8);
  const maximum = 12 + headerBytes.length + header.manifestBytes + payloadBytes + header.segments * (prefixBytes + backupCipherOverhead + frameBytes);
  const space = await fs.statfs(directory, { bigint: true });
  if (space.bavail * space.bsize < BigInt(maximum + Math.min(segmentBytes, payloadBytes) + capsuleLimits.reserveBytes)) throw fail();
  const temporary = path.join(directory, `.capsule-${randomUUID()}.partial`);
  const segment = path.join(directory, `.segment-${randomUUID()}.orbis`);
  const cursor = new Cursor(sourceBytes(options.entries, options.signal)[Symbol.asyncIterator]());
  let output: FileHandle | undefined;
  let linked = false;
  const digest = createHash('sha256');
  let outputBytes = 0;
  const append = async (data: Buffer) => {
    options.signal.throwIfAborted();
    if (outputBytes + data.length > maximum) throw fail();
    await write(output as FileHandle, data);
    digest.update(data);
    outputBytes += data.length;
  };
  try {
    options.signal.throwIfAborted();
    output = await fs.open(temporary, 'wx', 0o600);
    await append(start);
    await append(headerBytes);
    await append(encryptedManifest);
    let completed = 0;
    options.progress?.(0, payloadBytes);
    for (let index = 0; index < header.segments; index++) {
      options.signal.throwIfAborted();
      const count = Math.min(segmentBytes, payloadBytes - completed);
      const prefix = segmentPrefix(header, index);
      const source = Readable.from(
        (async function* () {
          yield prefix;
          yield* cursor.take(count);
        })(),
      );
      const encrypted = await encryptBackupStream({
        source,
        plaintextBytes: prefixBytes + count,
        destination: segment,
        passphrase: options.passphrase,
        signal: options.signal,
      });
      const frame = Buffer.alloc(frameBytes);
      frame.writeUInt32BE(index);
      frame.writeBigUInt64BE(BigInt(encrypted.bytes), 4);
      Buffer.from(encrypted.sha256, 'hex').copy(frame, 12);
      await append(frame);
      const frozen = await safeFile(segment, encrypted.bytes);
      try {
        for await (const chunk of frozen.handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, signal: options.signal }))
          await append(Buffer.from(chunk));
        if (!same(frozen.stat, await frozen.handle.stat())) throw fail();
      } finally {
        await frozen.handle.close();
      }
      await fs.unlink(segment);
      completed += count;
      options.progress?.(completed, payloadBytes);
    }
    await cursor.finish();
    if (outputBytes !== maximum) throw fail();
    await output.sync();
    await output.close();
    output = undefined;
    options.signal.throwIfAborted();
    await fs.link(temporary, options.destination);
    linked = true;
    await sync(directory);
    return { capsuleId, bytes: outputBytes, sha256: digest.digest('hex'), segments: header.segments };
  } catch (error) {
    if (linked) await fs.rm(options.destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await cursor.close().catch(() => undefined);
    await output?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
    await fs.rm(segment, { force: true });
  }
}

/** Authenticates outer framing and every segment before fixed-name private staging; never activates a capsule. */
export async function importCapsule(options: {
  source: string;
  stagingParent: string;
  passphrase: string;
  expectedSha256?: string;
  signal: AbortSignal;
  verify: (manifest: CapsuleManifest, directory: string, signal: AbortSignal) => Promise<void>;
}) {
  await privateBackupDirectory(options.stagingParent);
  const source = await safeFile(options.source, capsuleLimits.bytes + 1024 * 1024 * 8);
  let directory: string | undefined;
  let keep = false;
  const outputs = new Map<string, FileHandle>();
  let secret: Buffer | undefined;
  try {
    options.signal.throwIfAborted();
    const capsuleDigest = createHash('sha256');
    for await (const chunk of source.handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024, signal: options.signal }))
      capsuleDigest.update(chunk);
    const capsuleSha256 = capsuleDigest.digest('hex');
    if (options.expectedSha256 !== undefined && (!hash.allows(options.expectedSha256) || capsuleSha256 !== options.expectedSha256)) throw fail();
    if (!same(source.stat, await source.handle.stat())) throw fail();
    const initial = await read(source.handle, 12, 0);
    if (!initial.subarray(0, 8).equals(magic)) throw fail();
    const length = initial.readUInt32BE(8);
    if (length < 1 || length > 4096) throw fail();
    const encoded = await read(source.handle, length, 12);
    const header = headerSchema.assert(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded)));
    if (!encoded.equals(Buffer.from(canonicalHeader(header)))) throw fail();
    const expectedBytes =
      12 + length + header.manifestBytes + header.payloadBytes + header.segments * (prefixBytes + backupCipherOverhead + frameBytes);
    if (expectedBytes !== source.stat.size) throw fail();
    const encryptedManifest = await read(source.handle, header.manifestBytes, 12 + length);
    if (sha(encryptedManifest) !== header.manifestSha256) throw fail();
    secret = await backupMetadataBytes(encryptedManifest, options.passphrase, true, capsuleLimits.manifestBytes);
    const manifest = capsuleManifestSchema.assert(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(secret)));
    if ((header.schema === 'orbis.time-machine-capsule.v2') !== (manifest.schema === 'orbis.time-machine-capsule-private.v2')) throw fail();
    validateEntries(manifest.entries);
    if (manifest.capsuleId !== header.capsuleId || manifest.entries.reduce((sum, entry) => sum + entry.bytes, 0) !== header.payloadBytes)
      throw fail();
    const space = await fs.statfs(options.stagingParent, { bigint: true });
    if (
      space.bavail * space.bsize <
      BigInt(header.payloadBytes + Math.min(header.segmentBytes, header.payloadBytes) * 2 + capsuleLimits.reserveBytes)
    )
      throw fail();
    directory = await fs.mkdtemp(path.join(options.stagingParent, 'capsule-'));
    await fs.chmod(directory, 0o700);
    let position = 12 + length + header.manifestBytes;
    let completed = 0;
    let current = 0;
    let entryReceived = 0;
    let entryHash = createHash('sha256');
    const consume = async (bytes: Buffer) => {
      let offset = 0;
      while (offset < bytes.length) {
        const entry = manifest.entries[current];
        if (!entry) throw fail();
        let output = outputs.get(entry.name);
        if (!output) {
          output = await fs.open(path.join(directory as string, entry.name), 'wx', 0o600);
          outputs.set(entry.name, output);
        }
        const count = Math.min(bytes.length - offset, entry.bytes - entryReceived);
        const value = bytes.subarray(offset, offset + count);
        await write(output, value);
        entryHash.update(value);
        entryReceived += count;
        offset += count;
        if (entryReceived === entry.bytes) {
          if (entryHash.digest('hex') !== entry.sha256) throw fail();
          await output.sync();
          await output.close();
          outputs.delete(entry.name);
          current++;
          entryReceived = 0;
          entryHash = createHash('sha256');
        }
      }
    };
    for (let index = 0; index < header.segments; index++) {
      options.signal.throwIfAborted();
      const frame = await read(source.handle, frameBytes, position);
      position += frameBytes;
      const count = Math.min(header.segmentBytes, header.payloadBytes - completed);
      const encryptedBytes = count + prefixBytes + backupCipherOverhead;
      if (frame.readUInt32BE(0) !== index || frame.readBigUInt64BE(4) !== BigInt(encryptedBytes)) throw fail();
      const encryptedPath = path.join(directory, 'segment.orbis');
      const plainPath = path.join(directory, 'segment.ciphers');
      const output = await fs.open(encryptedPath, 'wx', 0o600);
      const digest = createHash('sha256');
      try {
        let remaining = encryptedBytes;
        while (remaining) {
          options.signal.throwIfAborted();
          const value = await read(source.handle, Math.min(64 * 1024, remaining), position);
          position += value.length;
          remaining -= value.length;
          digest.update(value);
          await write(output, value);
        }
        await output.sync();
      } finally {
        await output.close();
      }
      if (digest.digest('hex') !== frame.subarray(12).toString('hex')) throw fail();
      await decryptBackup({ source: encryptedPath, destination: plainPath, passphrase: options.passphrase, signal: options.signal });
      const plain = await safeFile(plainPath, count + prefixBytes);
      try {
        if (plain.stat.size !== count + prefixBytes || !(await read(plain.handle, prefixBytes, 0)).equals(segmentPrefix(header, index))) throw fail();
        let remaining = count;
        let offset = prefixBytes;
        while (remaining) {
          options.signal.throwIfAborted();
          const value = await read(plain.handle, Math.min(64 * 1024, remaining), offset);
          offset += value.length;
          remaining -= value.length;
          await consume(value);
        }
      } finally {
        await plain.handle.close();
      }
      await fs.unlink(encryptedPath);
      await fs.unlink(plainPath);
      completed += count;
    }
    if (current !== manifest.entries.length || entryReceived || position !== source.stat.size || !same(source.stat, await source.handle.stat()))
      throw fail();
    await options.verify(manifest, directory, options.signal);
    options.signal.throwIfAborted();
    await sync(directory);
    await sync(options.stagingParent);
    keep = true;
    return {
      directory,
      capsuleId: header.capsuleId,
      sha256: capsuleSha256,
      pointId: manifest.pointId,
      createdAt: manifest.createdAt,
      bytes: header.payloadBytes,
      restoreSupported: false as const,
      dispose: () => fs.rm(directory as string, { recursive: true, force: true }),
    };
  } finally {
    secret?.fill(0);
    await source.handle.close();
    for (const file of outputs.values()) await file.close().catch(() => undefined);
    if (directory && !keep) await fs.rm(directory, { recursive: true, force: true });
  }
}
