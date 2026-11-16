import { createHash } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import { backupMetadataBytes, createBackupCiphertextSequenceInspector } from './backup-crypto';
import {
  inspectResetCaptureRecoveryManifest,
  inspectResetCaptureRecoveryMetadata,
  resetCaptureRecoveryManifest,
  validateResetCaptureRecoveryManifest,
  type ResetCaptureRecoveryBinding,
  type ResetCaptureRecoveryManifest,
} from './reset-capture-recovery-manifest';
import { parseResetSafetyJson, resetSafetyJson } from './reset-safety-archive-contract';
import { writeResetSafetyTar } from './reset-safety-tar';
import { sealedBundleFiles } from './settings-backup-format';
import { assertResetInventoryAccess, type ResetInventoryAccess, type ResetInventoryBinding } from './settings-export-authorization';
import type { TimeMachineService } from './time-machine.service';

const limits = { index: 4 * 1024 ** 2, manifest: 16 * 1024 ** 2 + 4096, archive: 8 * 1024 ** 4 + 64 * 1024 ** 2, parts: 16_000 };
const fail = () => new Error('The retained capture recovery archive could not be verified. Keep its original captures, keys and staging files.');
const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const part = type({
  name: type('string').narrow((value) => value.startsWith('parts/') && value.endsWith('.orbis') && uuid.allows(value.slice(6, -6))),
  bytes: type('number.integer >= 52').narrow((value) => value <= 1024 ** 3 + 52),
  sha256: hash,
});
const indexSchema = type({
  format: "'orbis-reset-capture-archive'",
  version: '1',
  resetId: uuid,
  manifest: { bytes: type('number.integer >= 52').narrow((value) => value <= limits.manifest + 52), sha256: hash },
  parts: part.array().atMostLength(limits.parts),
}).onDeepUndeclaredKey('reject');
const envelopeSchema = type({
  format: "'orbis-reset-capture-manifest'",
  version: '1',
  indexSha256: hash,
  captures: 'unknown',
}).onUndeclaredKey('reject');
type Index = typeof indexSchema.infer;
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const indexDigest = (index: Pick<Index, 'format' | 'version' | 'resetId' | 'parts'>) =>
  sha(
    resetSafetyJson({
      format: index.format,
      version: index.version,
      resetId: index.resetId,
      parts: index.parts,
    }),
  );
const binding = (manifest: ResetCaptureRecoveryManifest): ResetCaptureRecoveryBinding =>
  Object.freeze({
    resetId: manifest.resetId,
    accounts: manifest.accounts,
    filesSha256: manifest.filesSha256,
    inventorySha256: manifest.inventory.sha256,
  });
function validateIndex(input: unknown) {
  const index = indexSchema.assert(input);
  if (
    new Set(index.parts.map((part) => part.name)).size !== index.parts.length ||
    index.parts.reduce((sum, part) => sum + part.bytes, 0) > limits.archive
  )
    throw fail();
  return index;
}

type ArchiveInspectionOptions = {
  source: string;
  directory: string;
  passphrase: string;
  signal: AbortSignal;
  expected?: ResetCaptureRecoveryBinding & { bytes?: number; sha256?: string };
};
type RecoveryFile = Extract<ResetCaptureRecoveryManifest['entries'][number], { type: 'file' }>;
const fileSeal = (s: Awaited<ReturnType<typeof fs.lstat>>) => [s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');

/** Retains extracted encrypted members; the caller owns staging and gains no import, custody or erase authority. */
export const inspectResetCaptureRecoveryArchive = (options: ArchiveInspectionOptions) => inspectArchive(options, false);

/** Verifies one encrypted chunk at a time, releasing only verified scratch members and retaining the original archive. */
export async function verifyResetCaptureRecoveryArchive(options: ArchiveInspectionOptions) {
  const { bytes, sha256, manifest } = await inspectArchive(options, true);
  return Object.freeze({ bytes, sha256, manifest });
}

async function inspectArchive(options: ArchiveInspectionOptions, bounded: boolean) {
  const { source, directory, passphrase, signal } = options;
  const expected = options.expected ? { ...options.expected } : undefined;
  sealedBundleFiles.outside(directory, source);
  signal.throwIfAborted();
  await sealedBundleFiles.fresh(directory);
  const storage = await fs.lstat(directory);
  const sameStorage = async () => {
    const current = await fs.lstat(directory);
    if (
      current.dev !== storage.dev ||
      current.ino !== storage.ino ||
      current.uid !== storage.uid ||
      current.mode !== storage.mode ||
      (await fs.realpath(directory)) !== directory
    )
      throw fail();
  };
  let index: Index | undefined;
  let manifest: ResetCaptureRecoveryManifest | undefined;
  let position = 0;
  let chunks: Buffer[] = [];
  let selected: Index['parts'][number] | undefined;
  let digest = createHash('sha256');
  let count = 0;
  let output: FileHandle | undefined;
  let members: { item: RecoveryFile; chunk: RecoveryFile['chunks'][number]; last: boolean }[] = [];
  let sequence: ReturnType<typeof createBackupCiphertextSequenceInspector> | undefined;
  const seen = new Set<string>();
  try {
    const archive = await sealedBundleFiles.readTar(source, signal, limits.archive, {
      strict: true,
      collectEntries: false,
      maxEntries: limits.parts + 2,
      maxExpandedBytes: limits.archive,
      onEntry: async (entry) => {
        signal.throwIfAborted();
        if (entry.type !== '-' || entry.size < 1 || !Number.isSafeInteger(entry.size) || seen.has(entry.path)) throw fail();
        seen.add(entry.path);
        chunks = [];
        count = 0;
        digest = createHash('sha256');
        selected = undefined;
        if (position === 0) {
          if (entry.path !== 'bundle.json' || entry.size > limits.index) throw fail();
        } else if (position === 1) {
          if (!index || entry.path !== 'manifest.orbis' || entry.size !== index.manifest.bytes) throw fail();
        } else {
          selected = index?.parts[position - 2];
          if (!manifest || !selected || entry.path !== selected.name || entry.size !== selected.bytes) throw fail();
          await sameStorage();
          await sealedBundleFiles.capacity(directory, entry.size);
          output = await fs.open(path.join(directory, selected.name.slice(6)), 'wx', 0o600);
        }
      },
      onData: async (data) => {
        signal.throwIfAborted();
        digest.update(data);
        count += data.length;
        if (position < 2) chunks.push(Buffer.from(data));
        else {
          if (!output) throw fail();
          let offset = 0;
          while (offset < data.length) {
            const written = await output.write(data, offset, data.length - offset);
            if (!written.bytesWritten) throw fail();
            offset += written.bytesWritten;
          }
        }
      },
      onEntryEnd: async () => {
        const measured = digest.digest('hex');
        if (position === 0) index = validateIndex(parseResetSafetyJson(Buffer.concat(chunks)));
        else if (position === 1) {
          if (!index || count !== index.manifest.bytes || measured !== index.manifest.sha256) throw fail();
          const plaintext = await backupMetadataBytes(Buffer.concat(chunks), passphrase, true, limits.manifest);
          try {
            const envelope = envelopeSchema.assert(parseResetSafetyJson(plaintext));
            if (envelope.indexSha256 !== indexDigest(index)) throw fail();
            manifest = validateResetCaptureRecoveryManifest(envelope.captures);
          } finally {
            plaintext.fill(0);
          }
          members = manifest.entries.flatMap((item) =>
            item.type === 'file' ? item.chunks.map((chunk, at) => ({ item, chunk, last: at === item.chunks.length - 1 })) : [],
          );
          if (
            manifest.resetId !== index.resetId ||
            members.length !== index.parts.length ||
            members.some(({ chunk: member }, at) => {
              const part = index?.parts[at];
              return part?.name !== `parts/${member.part}` || part.bytes !== member.bytes || part.sha256 !== member.sha256;
            })
          )
            throw fail();
          if (expected && Object.entries(binding(manifest)).some(([key, value]) => expected[key as keyof ResetCaptureRecoveryBinding] !== value))
            throw fail();
          await sealedBundleFiles.capacity(
            directory,
            bounded ? Math.max(0, ...index.parts.map((part) => part.bytes)) : index.parts.reduce((sum, part) => sum + part.bytes, 0),
          );
        } else {
          if (!output) throw fail();
          await output?.sync();
          const completed = await output.stat();
          await output?.close();
          output = undefined;
          if (!selected || count !== selected.bytes || measured !== selected.sha256) throw fail();
          if (bounded) {
            const member = members[position - 2];
            if (!manifest || !member) throw fail();
            if (member.chunk.offset === 0) {
              if (sequence) throw fail();
              sequence = createBackupCiphertextSequenceInspector({ passphrase, signal });
            }
            if (!sequence) throw fail();
            const source = path.join(directory, selected.name.slice(6));
            if (fileSeal(await fs.lstat(source)) !== fileSeal(completed)) throw fail();
            const inspected = await sequence.add({ source, plaintextBytes: member.chunk.plaintextBytes });
            if (inspected.plaintextSha256 !== member.chunk.plaintextSha256) throw fail();
            if (member.last) {
              const file = sequence.finish();
              sequence = undefined;
              if (file.plaintextBytes !== member.item.plaintextBytes || file.plaintextSha256 !== member.item.plaintextSha256) throw fail();
              await inspectResetCaptureRecoveryMetadata({ manifest, item: member.item, source, passphrase, signal });
            }
            signal.throwIfAborted();
            await sameStorage();
            if (fileSeal(await fs.lstat(source)) !== fileSeal(completed)) throw fail();
            await fs.unlink(source);
          }
        }
        position++;
      },
    });
    if (
      !index ||
      !manifest ||
      position !== index.parts.length + 2 ||
      (expected?.bytes !== undefined && archive.bytes !== expected.bytes) ||
      (expected?.sha256 !== undefined && archive.sha256 !== expected.sha256)
    )
      throw fail();
    if (bounded) {
      await sameStorage();
      if (sequence || (await fs.readdir(directory)).length) throw fail();
    } else await inspectResetCaptureRecoveryManifest({ manifest, expected: expected ?? binding(manifest), directory, passphrase, signal });
    const remeasured = await sealedBundleFiles.measure(source, signal, archive.bytes);
    if (remeasured.bytes !== archive.bytes || remeasured.sha256 !== archive.sha256) throw fail();
    signal.throwIfAborted();
    return Object.freeze({ ...archive, manifest, directory });
  } finally {
    await output?.close();
  }
}

/** Packages a real fenced raw-store snapshot as one authenticated section for the complete reset archive. */
export async function exportResetCaptureRecoveryArchive(
  options: ResetInventoryBinding & {
    access: ResetInventoryAccess;
    machine: Pick<TimeMachineService, 'withResetCaptureRecoveryFiles'>;
    directory: string;
    destination: string;
    passphrase: string;
  },
) {
  const { machine, access, directory, destination, passphrase, signal } = options;
  const scope = { resetId: options.resetId, accounts: options.accounts, lease: options.lease, signal };
  const guard = () => assertResetInventoryAccess(access, scope);
  await guard();
  if (!path.isAbsolute(destination) || path.resolve(destination) !== destination) throw fail();
  sealedBundleFiles.outside(directory, destination);
  await fs.lstat(destination).then(
    () => {
      throw fail();
    },
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    },
  );
  await sealedBundleFiles.fresh(directory);
  const captures = path.join(directory, 'captures');
  await sealedBundleFiles.fresh(captures);
  const result = await machine.withResetCaptureRecoveryFiles({ ...scope, access, directory: captures, passphrase }, async (snapshot) => {
    const manifest = resetCaptureRecoveryManifest(snapshot);
    const members = snapshot.entries.flatMap((entry) =>
      entry.type === 'file'
        ? entry.chunks.map((chunk) => ({
            name: `parts/${path.basename(chunk.file)}`,
            file: chunk.file,
            bytes: chunk.bytes,
            sha256: chunk.sha256,
          }))
        : [],
    );
    const partial = {
      format: 'orbis-reset-capture-archive' as const,
      version: 1 as const,
      resetId: snapshot.resetId,
      parts: members.map(({ file: _file, ...part }) => part),
    };
    const plaintext = resetSafetyJson({ format: 'orbis-reset-capture-manifest', version: 1, indexSha256: indexDigest(partial), captures: manifest });
    let encrypted: Buffer;
    try {
      encrypted = await backupMetadataBytes(plaintext, passphrase, false, limits.manifest);
    } finally {
      plaintext.fill(0);
    }
    const index = validateIndex({ ...partial, manifest: { bytes: encrypted.length, sha256: sha(encrypted) } });
    const encoded = resetSafetyJson(index);
    if (encoded.length > limits.index) throw fail();
    await guard();
    const archive = await writeResetSafetyTar({
      destination,
      entries: [{ name: 'bundle.json', data: encoded }, { name: 'manifest.orbis', data: encrypted }, ...members],
      signal,
    });
    await guard();
    const inspected = await verifyResetCaptureRecoveryArchive({
      source: destination,
      directory: path.join(directory, 'verify'),
      passphrase,
      signal,
      expected: { ...binding(manifest), ...archive },
    });
    await guard();
    return Object.freeze({ ...archive, ...binding(inspected.manifest) });
  });
  await guard();
  const final = await sealedBundleFiles.measure(destination, signal, result.bytes);
  if (final.bytes !== result.bytes || final.sha256 !== result.sha256) throw fail();
  await guard();
  return result;
}
