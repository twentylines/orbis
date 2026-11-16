import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sealedBundleFiles } from './settings-backup-format';

type Entry = { name: string; data: Buffer } | { name: string; file: string; bytes: number; sha256: string };
const fail = () => new Error('The reset safety archive could not be written.');

export function resetSafetyTarHeader(name: string, bytes: number) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9./_-]{0,99}$/.test(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..') ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0
  )
    throw fail();
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'ascii');
  header.write('0000600\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  if (bytes <= 0o77777777777) header.write(`${bytes.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  else {
    let size = BigInt(bytes);
    for (let at = 135; at >= 124; at--) {
      header[at] = Number(size & 255n);
      size >>= 8n;
    }
    header[124] = (header[124] ?? 0) | 0x80;
  }
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

/** Streams already-encrypted members once; no second multi-terabyte staging copy is needed. */
export async function writeResetSafetyTar(options: {
  destination: string;
  entries: Entry[];
  maxEntries?: number;
  signal: AbortSignal;
  progress?: (done: number, total: number) => void;
}) {
  const { destination, signal } = options;
  const maxEntries = options.maxEntries ?? 20_000;
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > 32_099 ||
    !path.isAbsolute(destination) ||
    path.resolve(destination) !== destination ||
    !options.entries.length ||
    options.entries.length > maxEntries
  )
    throw fail();
  const names = new Set<string>();
  const entries = options.entries.map((entry) => {
    if (names.has(entry.name)) throw fail();
    names.add(entry.name);
    if ('data' in entry) {
      if (!Buffer.isBuffer(entry.data)) throw fail();
      const data = Buffer.from(entry.data);
      resetSafetyTarHeader(entry.name, data.length);
      return { name: entry.name, data, bytes: data.length };
    }
    if (!path.isAbsolute(entry.file) || path.resolve(entry.file) !== entry.file || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw fail();
    resetSafetyTarHeader(entry.name, entry.bytes);
    return { ...entry };
  });
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const archiveBytes = entries.reduce((sum, entry) => sum + 512 + Math.ceil(entry.bytes / 512) * 512, 1024);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(archiveBytes)) throw fail();
  const parent = path.dirname(destination);
  const directory = await fs.open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  let owned: Awaited<ReturnType<typeof fs.stat>> | undefined;
  const temporary = path.join(parent, `.reset-safety-${randomUUID()}.partial`);
  const stat = await directory.stat();
  const parentCurrent = async () => {
    const current = await fs.lstat(parent);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      current.mode !== stat.mode ||
      current.uid !== stat.uid ||
      current.mode & 0o077 ||
      current.uid !== process.getuid?.() ||
      (await fs.realpath(parent)) !== parent
    )
      throw fail();
  };
  let committed = false;
  try {
    signal.throwIfAborted();
    await parentCurrent();
    await sealedBundleFiles.capacity(parent, archiveBytes);
    output = await fs.open(temporary, 'wx', 0o600);
    owned = await output.stat();
    const digest = createHash('sha256');
    let completed = 0;
    const write = async (data: Buffer) => {
      signal.throwIfAborted();
      digest.update(data);
      let offset = 0;
      while (offset < data.length) {
        const result = await output?.write(data, offset, data.length - offset);
        if (!result?.bytesWritten) throw fail();
        offset += result.bytesWritten;
      }
    };
    options.progress?.(0, total);
    for (const entry of entries) {
      await write(resetSafetyTarHeader(entry.name, entry.bytes));
      if ('data' in entry && entry.data) {
        await write(entry.data);
        completed += entry.bytes;
      } else {
        if (!('file' in entry) || (await fs.realpath(entry.file)) !== entry.file) throw fail();
        const source = await sealedBundleFiles.open(entry.file);
        try {
          if (source.stat.size !== entry.bytes) throw fail();
          const member = createHash('sha256');
          const buffer = Buffer.alloc(256 * 1024);
          let position = 0;
          while (position < entry.bytes) {
            const read = await source.handle.read(buffer, 0, Math.min(buffer.length, entry.bytes - position), position);
            if (!read.bytesRead) throw fail();
            const chunk = buffer.subarray(0, read.bytesRead);
            member.update(chunk);
            await write(chunk);
            position += read.bytesRead;
            completed += read.bytesRead;
            options.progress?.(completed, total);
          }
          if (
            member.digest('hex') !== entry.sha256 ||
            sealedBundleFiles.seal(await source.handle.stat()) !== sealedBundleFiles.seal(source.stat) ||
            sealedBundleFiles.seal(await fs.lstat(entry.file)) !== sealedBundleFiles.seal(source.stat)
          )
            throw fail();
        } finally {
          await source.handle.close();
        }
      }
      const padding = (512 - (entry.bytes % 512)) % 512;
      if (padding) await write(Buffer.alloc(padding));
      options.progress?.(completed, total);
    }
    await write(Buffer.alloc(1024));
    await output.sync();
    const sealed = await output.stat();
    if (sealed.size !== archiveBytes || sealedBundleFiles.seal(await fs.lstat(temporary)) !== sealedBundleFiles.seal(sealed)) throw fail();
    await parentCurrent();
    signal.throwIfAborted();
    await fs.link(temporary, destination);
    await fs.unlink(temporary);
    await directory.sync();
    const published = await fs.lstat(destination);
    if (
      published.dev !== sealed.dev ||
      published.ino !== sealed.ino ||
      published.nlink !== 1 ||
      published.size !== archiveBytes ||
      published.mode !== sealed.mode ||
      published.uid !== sealed.uid ||
      published.mode & 0o077
    )
      throw fail();
    committed = true;
    return { bytes: archiveBytes, sha256: digest.digest('hex') };
  } finally {
    try {
      await output?.close();
      if (owned) {
        await parentCurrent();
        for (const file of [temporary, ...(committed ? [] : [destination])]) {
          const current = await fs.lstat(file).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
          });
          if (current?.dev === owned.dev && current.ino === owned.ino) await fs.unlink(file);
        }
      }
    } finally {
      await directory.close();
    }
  }
}
