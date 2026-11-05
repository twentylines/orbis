import { createHash } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { CapsuleEntry } from './capsule';

type Seal = Awaited<ReturnType<FileHandle['stat']>>;
export const sameCapsuleSeal = (first: Seal, second: Seal) =>
  ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'nlink', 'mtimeMs', 'ctimeMs'].every((key) => Reflect.get(first, key) === Reflect.get(second, key));
export const sameCapsuleDirectorySeal = (first: Seal, second: Seal) =>
  ['dev', 'ino', 'mode', 'uid', 'gid'].every((key) => Reflect.get(first, key) === Reflect.get(second, key));
const fail = () => new Error('The verified capsule source changed or is no longer private.');

export async function capsuleDirectorySeal(directory: string) {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (await fs.realpath(directory)) !== path.resolve(directory)
  )
    throw fail();
  return stat;
}

export async function inspectCapsuleEntry(
  directory: string,
  entry: CapsuleEntry,
  signal: AbortSignal,
  expected?: Seal,
  destination?: string,
  collect?: (chunk: Buffer) => void,
) {
  await capsuleDirectorySeal(directory);
  const source = path.join(directory, entry.name);
  const input = await fs.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let output: FileHandle | undefined;
  try {
    const before = await input.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.mode & 0o077 ||
      before.size !== entry.bytes ||
      (process.getuid && before.uid !== process.getuid()) ||
      (expected && !sameCapsuleSeal(expected, before))
    )
      throw fail();
    if (destination) {
      await capsuleDirectorySeal(destination);
      output = await fs.open(
        path.join(destination, entry.name),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
    }
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const raw of input.createReadStream({ autoClose: false, signal })) {
      signal.throwIfAborted();
      const chunk = Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > entry.bytes) throw fail();
      hash.update(chunk);
      collect?.(chunk);
      if (output) {
        let offset = 0;
        while (offset < chunk.length) {
          const written = await output.write(chunk, offset, chunk.length - offset);
          if (!written.bytesWritten) throw fail();
          offset += written.bytesWritten;
        }
      }
    }
    if (
      bytes !== entry.bytes ||
      hash.digest('hex') !== entry.sha256 ||
      !sameCapsuleSeal(before, await input.stat()) ||
      !sameCapsuleSeal(before, await fs.lstat(source))
    )
      throw fail();
    await output?.sync();
    signal.throwIfAborted();
    return before;
  } finally {
    await output?.close();
    await input.close();
  }
}

export async function readCapsuleEntry(directory: string, entry: CapsuleEntry, signal: AbortSignal, maximum: number) {
  if (entry.bytes > maximum) throw fail();
  const chunks: Buffer[] = [];
  await inspectCapsuleEntry(directory, entry, signal, undefined, undefined, (chunk) => chunks.push(chunk));
  return Buffer.concat(chunks);
}
