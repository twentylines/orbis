import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

export const appMigrationIdPattern = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const appMigrationFileLimit = 256 * 1024;
const packageLimit = 4 * 1024 * 1024;
const invalid = () => new Error('Invalid application migration file.');
const directoryIdentity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode].join(':');
const fileIdentity = (stat: BigIntStats) => [directoryIdentity(stat), stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export type AppMigrationSource = Readonly<{ id: string; sha256: string; bytes: Buffer }>;

/** Raw app content has no authority. Execution must bind these bytes to an owned staged guard. */
async function readPackage(packageDirectory: string, selectedIds?: readonly string[]) {
  if (
    selectedIds !== undefined &&
    (!Array.isArray(selectedIds) ||
      selectedIds.length > 300 ||
      new Set(selectedIds).size !== selectedIds.length ||
      selectedIds.some((id) => typeof id !== 'string' || !appMigrationIdPattern.test(id)))
  )
    throw invalid();
  const selectedNames = selectedIds === undefined ? undefined : new Set(selectedIds.map((id) => `${id}.yml`));
  if (
    !path.isAbsolute(packageDirectory) ||
    path.resolve(packageDirectory) !== packageDirectory ||
    Buffer.byteLength(packageDirectory) > 4096 ||
    packageDirectory.split(path.sep).length > 128 ||
    /[\0\r\n]/.test(packageDirectory)
  )
    throw invalid();
  const held: { name: string; handle: FileHandle; identity: string }[] = [];
  const verify = async () => {
    for (const entry of held)
      if (
        directoryIdentity(await entry.handle.stat({ bigint: true })) !== entry.identity ||
        directoryIdentity(await fs.lstat(entry.name, { bigint: true })) !== entry.identity
      )
        throw invalid();
  };
  const pin = async (name: string) => {
    const parent = held.at(-1);
    const selected = process.platform === 'linux' && parent ? `/proc/self/fd/${parent.handle.fd}/${path.basename(name)}` : name;
    const handle = await fs.open(selected, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isDirectory()) throw invalid();
      held.push({ name, handle, identity: directoryIdentity(stat) });
    } catch (error) {
      await handle.close();
      throw error;
    }
  };
  const read = async (): Promise<{ ids: readonly string[]; sources: readonly AppMigrationSource[] }> => {
    const parts = packageDirectory.split(path.sep).filter(Boolean);
    await pin(path.parse(packageDirectory).root);
    let current = path.parse(packageDirectory).root;
    for (const part of parts) {
      current = path.join(current, part);
      await pin(current);
    }
    const directory = path.join(packageDirectory, 'migrations');
    try {
      await pin(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw invalid();
      await verify();
      await fs.lstat(directory).then(
        () => {
          throw invalid();
        },
        (absent: NodeJS.ErrnoException) => {
          if (absent.code !== 'ENOENT') throw absent;
        },
      );
      await verify();
      if (selectedIds?.length) throw invalid();
      return Object.freeze({ ids: Object.freeze([]), sources: Object.freeze([]) });
    }
    const parent = held.at(-1);
    if (!parent) throw invalid();
    const beforeDirectory = fileIdentity(await parent.handle.stat({ bigint: true }));
    const selected = process.platform === 'linux' ? `/proc/self/fd/${parent.handle.fd}` : directory;
    const entries = await fs.opendir(selected);
    const names: string[] = [];
    let count = 0;
    for await (const entry of entries) {
      if (++count > 4096) throw new Error('Application migration directory is too large.');
      if (entry.name.endsWith('.yaml')) throw new Error('App migrations must use the .yml extension.');
      if (!entry.name.endsWith('.yml')) continue;
      const id = entry.name.slice(0, -4);
      if (!appMigrationIdPattern.test(id) || !entry.isFile()) throw invalid();
      names.push(entry.name);
      if (names.length > 300) throw new Error('Application declares too many migrations.');
    }
    if (selectedNames && [...selectedNames].some((name) => !names.includes(name))) throw invalid();
    const result: AppMigrationSource[] = [];
    let bytes = 0;
    for (const name of names.sort()) {
      const file = path.join(selected, name);
      if (selectedNames && !selectedNames.has(name)) {
        const before = await fs.lstat(file, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || fileIdentity(await fs.lstat(file, { bigint: true })) !== fileIdentity(before)) throw invalid();
        continue;
      }
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.nlink !== 1n) throw invalid();
        if (before.size > BigInt(appMigrationFileLimit)) throw invalid();
        const buffer = Buffer.alloc(appMigrationFileLimit + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (
          length !== Number(before.size) ||
          length > appMigrationFileLimit ||
          fileIdentity(await handle.stat({ bigint: true })) !== fileIdentity(before) ||
          fileIdentity(await fs.lstat(file, { bigint: true })) !== fileIdentity(before)
        )
          throw invalid();
        bytes += length;
        if (bytes > packageLimit) throw new Error('Application migration package is too large.');
        result.push(
          Object.freeze({ id: name.slice(0, -4), sha256: hash(buffer.subarray(0, length)), bytes: Buffer.from(buffer.subarray(0, length)) }),
        );
      } finally {
        await handle.close();
      }
    }
    await verify();
    if (fileIdentity(await parent.handle.stat({ bigint: true })) !== beforeDirectory) throw invalid();
    return Object.freeze({ ids: Object.freeze(names.map((name) => name.slice(0, -4))), sources: Object.freeze(result) });
  };
  let result: Awaited<ReturnType<typeof read>> | undefined;
  let failure: unknown;
  let failed = false;
  try {
    result = await read();
  } catch (error) {
    failed = true;
    failure = error;
  }
  const closed = await Promise.allSettled(held.map(({ handle }) => handle.close()));
  if (closed.some((entry) => entry.status === 'rejected')) throw invalid();
  if (failed) {
    const messages = new Set([
      'Invalid application migration file.',
      'Application migration directory is too large.',
      'App migrations must use the .yml extension.',
      'Application declares too many migrations.',
      'Application migration package is too large.',
    ]);
    if (failure instanceof Error && messages.has(failure.message)) throw failure;
    throw invalid();
  }
  if (!result) throw invalid();
  return result;
}

export async function readAppMigrationIds(packageDirectory: string): Promise<readonly string[]> {
  return (await readPackage(packageDirectory, [])).ids;
}

/** Completed files are inspected as metadata only when selecting pending IDs. */
export async function readAppMigrationSources(packageDirectory: string, selectedIds?: readonly string[]): Promise<readonly AppMigrationSource[]> {
  return (await readPackage(packageDirectory, selectedIds)).sources;
}
