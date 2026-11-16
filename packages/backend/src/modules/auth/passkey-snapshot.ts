import { constants, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { PasskeyState } from './passkey.store';

const maximumBytes = 512 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export class PasskeySnapshotError extends Error {
  constructor() {
    super('Passkey snapshot storage needs local review.');
  }
}
const directoryIdentity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode].join(':');
const fileIdentity = (stat: BigIntStats) => [directoryIdentity(stat), stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`)
      .join(',')}}`;
  if (typeof value === 'number' && !Number.isFinite(value)) throw new PasskeySnapshotError();
  return JSON.stringify(value);
}

/** Pins read evidence only; host writer exclusion and reset/restore authority belong to the caller. */
export async function pinPasskeySnapshot(dataDir: string, expected: PasskeyState) {
  if (!path.isAbsolute(dataDir) || path.resolve(dataDir) !== dataDir) throw new PasskeySnapshotError();
  const expectedValue = canonical(expected);
  const auth = path.join(dataDir, 'state', 'auth');
  const file = path.join(auth, 'passkeys.json');
  const names = [dataDir, path.dirname(auth), auth];
  const directories: { name: string; handle: FileHandle; stat: BigIntStats }[] = [];
  let source: FileHandle | undefined;
  let sourceStat: BigIntStats | undefined;
  let reference = file;
  const close = async () => {
    await Promise.all([...directories.map((entry) => entry.handle.close()), source?.close() ?? Promise.resolve()]);
  };
  const current = (name: string) =>
    fs.lstat(name, { bigint: true }).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
  const checkDirectories = async () => {
    for (const name of names) {
      const pinned = directories.find((entry) => entry.name === name);
      const stat = await current(name);
      if (!stat) {
        if (pinned || name === dataDir) throw new PasskeySnapshotError();
        continue;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(name)) !== name) throw new PasskeySnapshotError();
      if (name === auth && (!pinned || stat.mode & 0o077n || (process.getuid && stat.uid !== BigInt(process.getuid()))))
        throw new PasskeySnapshotError();
      if (
        pinned &&
        (directoryIdentity(stat) !== directoryIdentity(pinned.stat) ||
          directoryIdentity(await pinned.handle.stat({ bigint: true })) !== directoryIdentity(pinned.stat))
      )
        throw new PasskeySnapshotError();
    }
  };
  const check = async () => {
    try {
      await checkDirectories();
      const stat = await current(reference);
      if (source && sourceStat) {
        if (
          !stat ||
          fileIdentity(stat) !== fileIdentity(sourceStat) ||
          fileIdentity(await source.stat({ bigint: true })) !== fileIdentity(sourceStat)
        )
          throw new PasskeySnapshotError();
      } else if (stat) throw new PasskeySnapshotError();
      await checkDirectories();
    } catch {
      throw new PasskeySnapshotError();
    }
  };
  try {
    for (const name of names) {
      const before = await current(name);
      if (!before) {
        if (name === dataDir) throw new PasskeySnapshotError();
        continue;
      }
      if (!before.isDirectory() || before.isSymbolicLink() || (await fs.realpath(name)) !== name) throw new PasskeySnapshotError();
      if (name === auth && (before.mode & 0o077n || (process.getuid && before.uid !== BigInt(process.getuid())))) throw new PasskeySnapshotError();
      const handle = await fs.open(name, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      directories.push({ name, handle, stat: before });
      if (directoryIdentity(await handle.stat({ bigint: true })) !== directoryIdentity(before)) throw new PasskeySnapshotError();
    }
    const parent = directories.find((entry) => entry.name === auth);
    if (parent && process.platform === 'linux') reference = `/proc/self/fd/${parent.handle.fd}/passkeys.json`;
    const before = await current(reference);
    if (before) {
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1n ||
        before.size > BigInt(maximumBytes) ||
        before.mode & 0o077n ||
        (process.getuid && before.uid !== BigInt(process.getuid()))
      )
        throw new PasskeySnapshotError();
      source = await fs.open(reference, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      sourceStat = await source.stat({ bigint: true });
      if (fileIdentity(sourceStat) !== fileIdentity(before)) throw new PasskeySnapshotError();
      const buffer = Buffer.alloc(maximumBytes + 1);
      let bytes = 0;
      try {
        for (;;) {
          const read = await source.read(buffer, bytes, buffer.length - bytes, bytes);
          bytes += read.bytesRead;
          if (bytes > maximumBytes) throw new PasskeySnapshotError();
          if (!read.bytesRead) break;
        }
        if (canonical(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)))) !== expectedValue)
          throw new PasskeySnapshotError();
      } finally {
        buffer.fill(0);
      }
    } else if (Object.keys(expected.users).length !== 0) throw new PasskeySnapshotError();
    await check();
    return { check, close };
  } catch {
    await close();
    throw new PasskeySnapshotError();
  }
}
