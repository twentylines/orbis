import crypto from 'node:crypto';
import fs, { constants } from 'node:fs';
import path from 'node:path';

const pending = new Map<string, Promise<string>>();
const invalid = () => new Error('CLI authentication storage is invalid or not private');
const owned = (stat: fs.Stats) => stat.uid === 0 || stat.uid === process.geteuid?.();
const same = (left: fs.Stats, right: fs.Stats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.uid === right.uid &&
  left.gid === right.gid &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

function checkDirectory(dataDir: string, privateMode: boolean) {
  const parent = fs.lstatSync(dataDir);
  const directory = fs.lstatSync(path.join(dataDir, '.secrets'));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o022) !== 0 ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    !owned(directory) ||
    (privateMode && (directory.mode & 0o7777) !== 0o700)
  )
    throw invalid();
  return directory;
}

function inspectKey(dataDir: string) {
  checkDirectory(dataDir, true);
  const name = path.join(dataDir, '.secrets', 'cli-secret');
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || !owned(stat) || stat.size > 64) throw invalid();
    const buffer = Buffer.alloc(65);
    const count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const secret = buffer.subarray(0, count).toString('utf8');
    if (!same(stat, fs.fstatSync(descriptor)) || !same(stat, fs.lstatSync(name))) throw invalid();
    return { stat, secret };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** A read-only startup never creates, repairs or rotates an authentication key. */
export function readCliSecret(dataDir: string): string | null {
  try {
    const { stat, secret } = inspectKey(dataDir);
    if ((stat.mode & 0o7777) !== 0o600 || !/^[a-f0-9]{64}$/.test(secret)) throw invalid();
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw invalid();
  }
}

async function syncDirectory(directory: string, pinned: fs.Stats) {
  const handle = await fs.promises.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (
      current.dev !== pinned.dev ||
      current.ino !== pinned.ino ||
      current.uid !== pinned.uid ||
      current.gid !== pinned.gid ||
      current.mode !== pinned.mode
    )
      throw invalid();
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function initialize(dataDir: string) {
  const directory = path.join(dataDir, '.secrets');
  const parent = await fs.promises.lstat(dataDir);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0) throw invalid();
  try {
    await fs.promises.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const before = checkDirectory(dataDir, false);
  if ((before.mode & 0o7777) !== 0o700) await fs.promises.chmod(directory, 0o700);
  const pinned = checkDirectory(dataDir, true);
  let original: ReturnType<typeof inspectKey> | null = null;
  try {
    original = inspectKey(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (original && (original.stat.mode & 0o7777) === 0o600 && /^[a-f0-9]{64}$/.test(original.secret)) {
    const file = await fs.promises.open(path.join(directory, 'cli-secret'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!same(original.stat, await file.stat())) throw invalid();
      await file.sync();
    } finally {
      await file.close();
    }
    await syncDirectory(directory, pinned);
    return original.secret;
  }
  if (original && original.stat.size !== 0 && (original.stat.mode & 0o077) === 0) throw invalid();

  const name = path.join(directory, 'cli-secret');
  const temporary = path.join(directory, `.cli-secret-${crypto.randomUUID()}.tmp`);
  const secret = crypto.randomBytes(32).toString('hex');
  const file = await fs.promises.open(temporary, 'wx', 0o600);
  let failed = false;
  let operationError: unknown;
  try {
    try {
      await file.writeFile(secret, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    const current = checkDirectory(dataDir, true);
    if (current.dev !== pinned.dev || current.ino !== pinned.ino || current.uid !== pinned.uid || current.gid !== pinned.gid) throw invalid();
    if (original) {
      if (!same(original.stat, fs.lstatSync(name))) throw invalid();
      await fs.promises.rename(temporary, name);
    } else {
      try {
        // Publish a complete first key without overwriting another creator's key.
        await fs.promises.link(temporary, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  } catch (error) {
    failed = true;
    operationError = error;
  }
  try {
    await fs.promises.unlink(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (failed) throw new AggregateError([operationError, error], 'CLI authentication key cleanup failed');
      throw error;
    }
  }
  if (failed) throw operationError;
  await syncDirectory(directory, pinned);
  const selected = readCliSecret(dataDir);
  if (!selected) throw invalid();
  return selected;
}

export function getCliSecret(dataDir: string): Promise<string> {
  const existing = pending.get(dataDir);
  if (existing) return existing;
  const operation = initialize(dataDir).finally(() => {
    if (pending.get(dataDir) === operation) pending.delete(dataDir);
  });
  pending.set(dataDir, operation);
  return operation;
}
