import fs, { type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { validateBackupTree } from './backup-links';
import { preserveTreeMetadata } from './restore-transaction';

type CopyOptions = { signal?: AbortSignal; check?: () => void; allowLinks?: boolean };
const maxNodes = 1_000_000;
const maxBytes = 1024n ** 4n;
const maxDepth = 128;
const readFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const changed = () => new Error('Backup input changed while it was being copied');
const check = (options: CopyOptions) => {
  options.signal?.throwIfAborted();
  options.check?.();
};
const same = (before: BigIntStats, after: BigIntStats) =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.mode === after.mode &&
  before.nlink === after.nlink &&
  before.uid === after.uid &&
  before.gid === after.gid &&
  before.size === after.size &&
  before.mtimeNs === after.mtimeNs &&
  before.ctimeNs === after.ctimeNs;
const requireSame = (before: BigIntStats, after: BigIntStats) => {
  if (!same(before, after)) throw changed();
};
const descriptorPath = (handle: FileHandle, fallback: string) => (process.platform === 'linux' ? `/proc/${process.pid}/fd/${handle.fd}/.` : fallback);

/** Copies bytes only from the checked descriptor; never reopens the input by name. */
export async function copyStableBackupFile(source: string, destination: string, options: CopyOptions = {}, remainingBytes = maxBytes) {
  check(options);
  const before = await fs.promises.lstat(source, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) throw new Error('Backup input is not a single-link regular file');
  if (before.size > remainingBytes) throw new Error('Backup copy exceeds its byte limit');
  const input = await fs.promises.open(source, readFlags);
  let output: FileHandle | undefined;
  try {
    requireSame(before, await input.stat({ bigint: true }));
    output = await fs.promises.open(destination, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Number(before.size) + 1));
    let position = 0;
    while (true) {
      check(options);
      const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      if (BigInt(position) > before.size) throw changed();
      let written = 0;
      while (written < bytesRead) {
        check(options);
        const result = await output.write(buffer, written, bytesRead - written);
        if (!result.bytesWritten) throw new Error('Backup copy could not be written');
        written += result.bytesWritten;
      }
    }
    if (BigInt(position) !== before.size) throw changed();
    requireSame(before, await input.stat({ bigint: true }));
    requireSame(before, await fs.promises.lstat(source, { bigint: true }));
    check(options);
    const copied = await output.stat({ bigint: true });
    await output.close();
    output = undefined;
    return { original: before, copied };
  } catch (error) {
    if (output) await fs.promises.unlink(destination).catch(() => undefined);
    throw error;
  } finally {
    await output?.close().catch(() => undefined);
    // Closing a read-only input must neither hide the copy failure nor discard
    // a complete, checked copy. Do not retry a raw fd after an uncertain close.
    await input.close().catch(() => undefined);
  }
}

type Captured = { original: BigIntStats; copied: BigIntStats; target?: string; children?: string[] };

/** Linux traversal pins every ancestor until its children have been checked. */
export async function copyStableBackupTree(source: string, destination: string, options: CopyOptions = {}) {
  check(options);
  const original = await fs.promises.lstat(source, { bigint: true });
  if (!original.isDirectory()) throw new Error('Backup input is not a regular directory');
  const root = await fs.promises.open(source, readFlags | fs.constants.O_DIRECTORY);
  const captured = new Map<string, Captured>();
  let bytes = 0n;
  let created = false;
  try {
    requireSame(original, await root.stat({ bigint: true }));
    await fs.promises.mkdir(destination, { mode: 0o700 });
    created = true;
    const visit = async (from: string, to: string, relative: string, depth: number): Promise<void> => {
      check(options);
      if (depth > maxDepth || captured.size >= maxNodes) throw new Error('Backup copy exceeds its tree limit');
      const entry = await fs.promises.lstat(from, { bigint: true });
      if (entry.isFile()) {
        const copied = await copyStableBackupFile(from, to, options, maxBytes - bytes);
        bytes += copied.original.size;
        captured.set(relative, copied);
      } else if (entry.isSymbolicLink()) {
        if (options.allowLinks === false) throw new Error('Backup contains unsupported file types');
        const target = await fs.promises.readlink(from);
        requireSame(entry, await fs.promises.lstat(from, { bigint: true }));
        await fs.promises.symlink(target, to);
        captured.set(relative, { original: entry, copied: await fs.promises.lstat(to, { bigint: true }), target });
      } else if (entry.isDirectory()) {
        const directory = relative ? await fs.promises.open(from, readFlags | fs.constants.O_DIRECTORY) : root;
        try {
          requireSame(entry, await directory.stat({ bigint: true }));
          if (relative) await fs.promises.mkdir(to, { mode: 0o700 });
          const pinned = descriptorPath(directory, from);
          const children = (await fs.promises.readdir(pinned)).sort();
          captured.set(relative, { original: entry, copied: await fs.promises.lstat(to, { bigint: true }), children });
          for (const name of children) await visit(path.join(pinned, name), path.join(to, name), path.join(relative, name), depth + 1);
          requireSame(entry, await directory.stat({ bigint: true }));
          requireSame(entry, await fs.promises.lstat(from, { bigint: true }));
        } finally {
          if (directory !== root) await directory.close().catch(() => undefined);
        }
      } else throw new Error('Backup contains unsupported file types');
    };
    const pinnedRoot = descriptorPath(root, source);
    await visit(pinnedRoot, destination, '', 0);
    const capturedRoot = captured.get('');
    if (!capturedRoot) throw changed();
    requireSame(original, capturedRoot.original);

    const verify = async (from: string, to: string, relative: string, metadata: boolean): Promise<void> => {
      check(options);
      const entry = captured.get(relative);
      if (!entry) throw changed();
      const current = await fs.promises.lstat(from, { bigint: true });
      requireSame(entry.original, current);
      const copied = await fs.promises.lstat(to, { bigint: true });
      if (
        copied.isDirectory() !== current.isDirectory() ||
        copied.isFile() !== current.isFile() ||
        copied.isSymbolicLink() !== current.isSymbolicLink() ||
        (!current.isSymbolicLink() && (copied.ino !== entry.copied.ino || copied.dev !== entry.copied.dev)) ||
        (current.isFile() && (copied.size !== current.size || copied.nlink !== 1n)) ||
        (metadata && (copied.mode !== current.mode || copied.uid !== current.uid || copied.gid !== current.gid || copied.mtimeNs !== current.mtimeNs))
      )
        throw changed();
      if (entry.target !== undefined && ((await fs.promises.readlink(from)) !== entry.target || (await fs.promises.readlink(to)) !== entry.target))
        throw changed();
      if (entry.children) {
        const directory = relative ? await fs.promises.open(from, readFlags | fs.constants.O_DIRECTORY) : root;
        try {
          requireSame(entry.original, await directory.stat({ bigint: true }));
          const pinned = descriptorPath(directory, from);
          if (
            JSON.stringify((await fs.promises.readdir(pinned)).sort()) !== JSON.stringify(entry.children) ||
            JSON.stringify((await fs.promises.readdir(to)).sort()) !== JSON.stringify(entry.children)
          )
            throw changed();
          for (const name of entry.children) await verify(path.join(pinned, name), path.join(to, name), path.join(relative, name), metadata);
          requireSame(entry.original, await directory.stat({ bigint: true }));
          requireSame(entry.original, await fs.promises.lstat(from, { bigint: true }));
        } finally {
          if (directory !== root) await directory.close().catch(() => undefined);
        }
      }
    };
    await verify(pinnedRoot, destination, '', false);
    await validateBackupTree(destination, options.allowLinks, options.signal);
    // The bulk pass only applies attributes. Captured inode/metadata checks on
    // both sides keep a later pathname lookup from authorizing different input.
    await preserveTreeMetadata(pinnedRoot, destination, options.allowLinks, options.signal);
    await verify(pinnedRoot, destination, '', true);
    requireSame(original, await fs.promises.lstat(source, { bigint: true }));
    check(options);
  } catch (error) {
    if (created) await fs.promises.rm(destination, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await root.close().catch(() => undefined);
  }
}
