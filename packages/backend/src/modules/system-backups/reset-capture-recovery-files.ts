import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { encryptBackupStream, inspectBackupCiphertext } from './backup-crypto';
import { sealedBundleFiles } from './settings-backup-format';
import { assertResetInventoryAccess, type ResetInventoryAccess, type ResetInventoryBinding } from './settings-export-authorization';
import { resetCaptureInventoryEntry, type ResetCaptureInventory } from './reset-safety-capture-inventory';

const chunkBytes = 1024 ** 3;
const limits = { fileBytes: 128 * 1024 ** 3, totalBytes: 8 * 1024 ** 4, entries: 12_000, directories: 2048, chunks: 16_000, depth: 32 };
const scopes = [
  ['points', ['backups', 'time-machine', 'points']],
  ['components', ['backups', 'time-machine', 'components']],
  ['keys', ['backups', 'time-machine', 'keys']],
  ['custody', ['backups', 'reset-capture-custody']],
] as const;
const fail = () => new Error('Retained capture recovery files could not be verified. Keep the original captures and keys for review.');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const seal = (s: Stats) => [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');
const identity = (s: Stats) => [s.dev, s.ino, s.mode, s.uid].join(':');
const safeName = (name: string) => /^[A-Za-z0-9._-]{1,255}$/.test(name) && name !== '.' && name !== '..';
type Directory = { handle: FileHandle; named: string; reference: string; stat: Stats; mount: string };
export type ResetCaptureRecoveryChunk = Readonly<{
  offset: number;
  plaintextBytes: number;
  plaintextSha256: string;
  file: string;
  bytes: number;
  sha256: string;
}>;
export type ResetCaptureRecoveryEntry =
  | Readonly<{ name: string; type: 'absent' | 'directory' }>
  | Readonly<{
      name: string;
      type: 'file';
      plaintextBytes: number;
      plaintextSha256: string;
      chunks: readonly ResetCaptureRecoveryChunk[];
    }>;
export type ResetCaptureRecoveryFiles = Readonly<{
  version: 1;
  resetId: string;
  accounts: 'keep' | 'remove';
  inventory: ResetCaptureInventory;
  filesSha256: string;
  entries: readonly ResetCaptureRecoveryEntry[];
}>;
export type ResetCaptureRecoveryOptions = ResetInventoryBinding & {
  access: ResetInventoryAccess;
  dataDir: string;
  directory: string;
  passphrase: string;
  inventory: () => Promise<ResetCaptureInventory>;
};

export function resetCaptureRecoveryChunks(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limits.fileBytes) throw fail();
  return Object.freeze(
    Array.from({ length: Math.max(1, Math.ceil(bytes / chunkBytes)) }, (_, at) =>
      Object.freeze({ offset: at * chunkBytes, plaintextBytes: Math.min(chunkBytes, bytes - at * chunkBytes) }),
    ),
  );
}

/** Preserves raw capture/key/custody bytes, not restore or replay authority. Caller owns all staging cleanup. */
export async function withResetCaptureRecoveryFiles<T>(
  options: ResetCaptureRecoveryOptions,
  work: (snapshot: ResetCaptureRecoveryFiles) => Promise<T>,
) {
  const { access, dataDir, directory, passphrase, signal, inventory } = options;
  const binding = { resetId: options.resetId, accounts: options.accounts, lease: options.lease, signal };
  const guard = () => assertResetInventoryAccess(access, binding);
  await guard();
  if (process.platform !== 'linux' || process.getuid?.() === undefined) throw fail();
  for (const name of [dataDir, directory])
    if (!path.isAbsolute(name) || path.resolve(name) !== name || (await fs.realpath(name)) !== name) throw fail();
  if (
    dataDir === directory ||
    dataDir.startsWith(`${directory}/`) ||
    scopes.some(([, parts]) => {
      const root = path.join(dataDir, ...parts);
      return directory === root || directory.startsWith(`${root}/`);
    })
  )
    throw fail();
  const initial = await inventory();
  if (initial.resetId !== binding.resetId || initial.accounts !== binding.accounts) throw fail();
  const directories: Directory[] = [];
  const files: { named: string; stat: Stats }[] = [];
  const absent = new Set<string>();
  const outputs: { file: string; stat: Stats }[] = [];
  const entries: ResetCaptureRecoveryEntry[] = [];
  const sourceIds = new Set<string>();
  const metadata = new Map<string, string>();
  let totalBytes = 0;
  let parts = 0;
  let scanned = 0;
  let staging: Directory | undefined;
  const mount = async (handle: FileHandle) => {
    const text = await fs.readFile(`/proc/self/fdinfo/${handle.fd}`, 'utf8');
    if (text.length > 4096) throw fail();
    const ids = [...text.matchAll(/^mnt_id:\s+(\d+)$/gm)];
    if (ids.length !== 1 || !ids[0]?.[1]) throw fail();
    return ids[0][1];
  };
  const current = async (opened: Directory) => {
    if (seal(await opened.handle.stat()) !== seal(opened.stat) || seal(await fs.lstat(opened.named)) !== seal(opened.stat)) throw fail();
  };
  const openDirectory = async (named: string, privateMode: boolean, parent?: Directory, allowMount = false): Promise<Directory> => {
    await guard();
    const existing = directories.find((opened) => opened.named === named);
    if (existing) {
      await current(existing);
      return existing;
    }
    if (directories.length >= limits.directories) throw fail();
    const before = await fs.lstat(named);
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid?.() || before.mode & (privateMode ? 0o077 : 0o022))
      throw fail();
    const handle = await fs.open(named, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (seal(await handle.stat()) !== seal(before)) throw fail();
      const reference = `/proc/self/fd/${handle.fd}`;
      if (seal(await fs.stat(reference)) !== seal(before)) throw fail();
      const id = `${before.dev}:${before.ino}`;
      if (sourceIds.has(id)) throw fail();
      const mountId = await mount(handle);
      if (parent && parent.mount !== mountId && !allowMount) throw fail();
      sourceIds.add(id);
      const result = { handle, named, reference, stat: before, mount: mountId };
      directories.push(result);
      return result;
    } catch (error) {
      await handle.close();
      throw error;
    }
  };
  const stageCurrent = async () => {
    if (
      !staging ||
      identity(await fs.lstat(directory)) !== identity(staging.stat) ||
      identity(await staging.handle.stat()) !== identity(staging.stat) ||
      (await fs.realpath(directory)) !== directory
    )
      throw fail();
  };
  const add = (entry: ResetCaptureRecoveryEntry) => {
    if (entries.length >= limits.entries || Buffer.byteLength(entry.name) > 4096) throw fail();
    entries.push(Object.freeze(entry));
  };
  const preflight = async (parent: Directory, child: string, depth: number): Promise<void> => {
    await guard();
    await current(parent);
    if (!safeName(child) || depth > limits.depth || ++scanned > limits.entries) throw fail();
    const named = `${parent.reference}/${child}`;
    const stat = await fs.lstat(named).catch((error: unknown) => {
      if (!missing(error)) throw error;
      absent.add(named);
      return null;
    });
    if (!stat) return;
    if (stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.isSymbolicLink()) throw fail();
    if (stat.isDirectory()) {
      const opened = await openDirectory(named, true, parent);
      for await (const entry of await fs.opendir(opened.reference)) await preflight(opened, entry.name, depth + 1);
      await current(opened);
    } else if (!stat.isFile() || stat.nlink !== 1) throw fail();
  };
  const visit = async (name: string, parent: Directory, child: string, depth: number): Promise<void> => {
    await guard();
    await current(parent);
    await stageCurrent();
    if (!safeName(child) || depth > limits.depth) throw fail();
    const named = `${parent.reference}/${child}`;
    const before = await fs.lstat(named).catch((error: unknown) => {
      if (!missing(error)) throw error;
      absent.add(named);
      return null;
    });
    if (!before) {
      add({ name, type: 'absent' });
      return;
    }
    if (before.uid !== process.getuid?.() || before.mode & 0o077 || before.isSymbolicLink()) throw fail();
    if (before.isDirectory()) {
      const opened = await openDirectory(named, true, parent);
      add({ name, type: 'directory' });
      for await (const entry of await fs.opendir(opened.reference)) await visit(`${name}/${entry.name}`, opened, entry.name, depth + 1);
      await current(opened);
      return;
    }
    if (!before.isFile() || before.nlink !== 1 || !Number.isSafeInteger(before.size) || before.size > limits.fileBytes) throw fail();
    const id = `${before.dev}:${before.ino}`;
    if (sourceIds.has(id)) throw fail();
    sourceIds.add(id);
    totalBytes += before.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.totalBytes) throw fail();
    const handle = await fs.open(named, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (seal(await handle.stat()) !== seal(before) || (await mount(handle)) !== parent.mount) throw fail();
      const chunks: ResetCaptureRecoveryChunk[] = [];
      const digest = createHash('sha256');
      for (const chunk of resetCaptureRecoveryChunks(before.size)) {
        await guard();
        await current(parent);
        await stageCurrent();
        if (++parts > limits.chunks) throw fail();
        const hash = createHash('sha256');
        const stream = Readable.from(
          (async function* () {
            const buffer = Buffer.alloc(1024 * 1024);
            let position = chunk.offset;
            try {
              while (position < chunk.offset + chunk.plaintextBytes) {
                signal.throwIfAborted();
                const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, chunk.offset + chunk.plaintextBytes - position), position);
                if (!bytesRead) throw fail();
                const data = buffer.subarray(0, bytesRead);
                hash.update(data);
                digest.update(data);
                position += bytesRead;
                yield Buffer.from(data);
              }
            } finally {
              buffer.fill(0);
            }
          })(),
        );
        const file = path.join(directory, `${randomUUID()}.orbis`);
        await sealedBundleFiles.capacity(directory, chunk.plaintextBytes + 52);
        const result = await encryptBackupStream({ source: stream, plaintextBytes: chunk.plaintextBytes, destination: file, passphrase, signal });
        const plaintextSha256 = hash.digest('hex');
        const verified = await inspectBackupCiphertext({ source: file, passphrase, plaintextBytes: chunk.plaintextBytes, signal });
        if (verified.plaintextSha256 !== plaintextSha256) throw fail();
        const outputStat = await fs.lstat(file);
        const encrypted = await sealedBundleFiles.measure(file, signal, result.bytes);
        if (encrypted.bytes !== result.bytes || encrypted.sha256 !== result.sha256 || seal(await fs.lstat(file)) !== seal(outputStat)) throw fail();
        outputs.push({ file, stat: outputStat });
        chunks.push(Object.freeze({ ...chunk, plaintextSha256, file, bytes: result.bytes, sha256: result.sha256 }));
      }
      if (/^(points|components)\/[a-f0-9-]{36}\/point\.json$/.test(name)) {
        if (before.size > 65536) throw fail();
        const data = Buffer.alloc(before.size);
        try {
          if ((await handle.read(data, 0, data.length, 0)).bytesRead !== data.length) throw fail();
          const point = JSON.parse(data.toString('utf8'));
          const [kind, id] = name.split('/');
          const record = initial.captures.find((record) => record.kind === (kind === 'points' ? 'core' : 'components') && record.id === id);
          if (!record || resetCaptureInventoryEntry(record.kind, point, record.effectiveOwnerId).metadataSha256 !== record.metadataSha256)
            throw fail();
          metadata.set(`${record.kind}:${record.id}`, record.metadataSha256);
        } finally {
          data.fill(0);
        }
      }
      if (seal(await handle.stat()) !== seal(before) || seal(await fs.lstat(named)) !== seal(before)) throw fail();
      files.push({ named, stat: before });
      add({ name, type: 'file', plaintextBytes: before.size, plaintextSha256: digest.digest('hex'), chunks: Object.freeze(chunks) });
    } finally {
      await handle.close();
    }
  };
  const verify = async () => {
    await guard();
    await stageCurrent();
    for (const opened of directories) await current(opened);
    for (const file of files) if (seal(await fs.lstat(file.named)) !== seal(file.stat)) throw fail();
    for (const named of absent) {
      const present = await fs.lstat(named).then(
        () => true,
        (error: unknown) => {
          if (!missing(error)) throw error;
          return false;
        },
      );
      if (present) throw fail();
    }
    const expected = new Set(outputs.map((output) => path.basename(output.file)));
    for (const output of outputs) if (seal(await fs.lstat(output.file)) !== seal(output.stat)) throw fail();
    for await (const entry of await fs.opendir(directory)) if (!expected.delete(entry.name)) throw fail();
    if (
      expected.size ||
      initial.captures.some((record) => metadata.get(`${record.kind}:${record.id}`) !== record.metadataSha256) ||
      (await inventory()).sha256 !== initial.sha256
    )
      throw fail();
    await guard();
  };
  const closeResources = async (primary: unknown) => {
    const handles = [
      ...directories.filter((opened) => opened.handle !== staging?.handle).map((opened) => opened.handle),
      ...(staging ? [staging.handle] : []),
    ];
    const closed = await Promise.allSettled(handles.map((handle) => handle.close()));
    const errors = closed.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
    if (errors.length)
      throw new AggregateError(primary === undefined ? errors : [primary, ...errors], 'Capture recovery descriptors could not be closed.');
  };
  let failure: unknown;
  try {
    staging = await openDirectory(directory, true);
    for await (const _entry of await fs.opendir(staging.reference)) throw fail();
    directories.pop();
    const root = await openDirectory(dataDir, false);
    const roots: { name: string; parent: Directory; child: string }[] = [];
    for (const [name, physical] of scopes) {
      let parent = root;
      let missingParent = false;
      for (const child of physical.slice(0, -1)) {
        const named = `${parent.reference}/${child}`;
        const present = await fs.lstat(named).catch((error: unknown) => {
          if (!missing(error)) throw error;
          absent.add(named);
          return null;
        });
        if (!present) {
          missingParent = true;
          break;
        }
        const already = directories.find((opened) => opened.named === named);
        parent = already ?? (await openDirectory(named, true, parent, parent === root && child === 'backups'));
      }
      if (missingParent) add({ name, type: 'absent' });
      else roots.push({ name, parent, child: physical.at(-1) ?? '' });
    }
    // Detect staging aliases to ANY source directory before writing the first encrypted member.
    for (const source of roots) await preflight(source.parent, source.child, 0);
    for (const source of roots) await visit(source.name, source.parent, source.child, 0);
    await verify();
    const ordered = Object.freeze(entries.sort((a, b) => a.name.localeCompare(b.name)));
    const projected = ordered.map((entry) =>
      entry.type === 'file' ? { ...entry, chunks: entry.chunks.map(({ file: _file, ...chunk }) => chunk) } : entry,
    );
    const snapshot: ResetCaptureRecoveryFiles = Object.freeze({
      version: 1,
      resetId: binding.resetId,
      accounts: binding.accounts,
      inventory: initial,
      filesSha256: createHash('sha256')
        .update('orbis-reset-capture-recovery-files-v1\n')
        .update(JSON.stringify({ resetId: binding.resetId, accounts: binding.accounts, inventorySha256: initial.sha256, entries: projected }))
        .digest('hex'),
      entries: ordered,
    });
    const result = await work(snapshot);
    await verify();
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await closeResources(failure);
  }
}
