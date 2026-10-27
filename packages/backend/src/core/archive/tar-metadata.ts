import fs from 'node:fs';
import { createGunzip } from 'node:zlib';

export type ArchiveEntry = { path: string; type: string; linkTarget?: string };
export type TarEntry = ArchiveEntry & { size: number };
export type TarReaderOptions = {
  strict?: boolean;
  maxEntries?: number;
  maxExpandedBytes?: number;
  collectEntries?: boolean;
  onEntry?: (entry: TarEntry) => Promise<void>;
  onData?: (data: Buffer) => Promise<void>;
  onEntryEnd?: () => Promise<void>;
};
const invalid = () => new Error('Invalid backup archive');
const text = (field: Buffer) => field.toString('utf8').replace(/\0.*$/s, '');
const sizeOf = (field: Buffer) => {
  let value = 0n;
  if (field[0] && field[0] & 0x80) {
    value = BigInt(field[0] & 0x7f);
    for (const byte of field.subarray(1)) value = value * 256n + BigInt(byte);
  } else {
    const octal = text(field).trim();
    if (!/^[0-7]+$/.test(octal)) throw invalid();
    value = BigInt(`0o${octal}`);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
  return Number(value);
};

const paxFields = (data: Buffer, strict = false) => {
  const fields: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    const lengthText = data.subarray(offset, space).toString('ascii');
    if (space < offset || !/^[1-9][0-9]*$/.test(lengthText)) throw invalid();
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 || offset + length > data.length || data[offset + length - 1] !== 10)
      throw invalid();
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equal = record.indexOf('=');
    if (equal < 1) throw invalid();
    const key = record.slice(0, equal);
    if (strict) {
      if (key === 'LIBARCHIVE.creationtime') {
        const value = record.slice(equal + 1);
        if (value.length > 64 || value !== value.trim() || !/^-?[0-9]+(?:\.[0-9]+)?$/.test(value)) throw invalid();
      } else if (!['path', 'linkpath', 'size', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname'].includes(key) || key in fields)
        throw invalid();
    }
    if (['path', 'linkpath', 'size'].includes(key)) {
      const value = record.slice(equal + 1);
      if (value.length > (key === 'size' ? 32 : 4096) || (key === 'size' && !/^(0|[1-9][0-9]*)$/.test(value))) throw invalid();
      fields[key] = value;
    }
    offset += length;
  }
  return fields;
};

export async function readTarArchive(file: string, gzip: boolean, signal?: AbortSignal, options: TarReaderOptions = {}): Promise<ArchiveEntry[]> {
  const source = fs.createReadStream(file, { signal });
  const gunzip = gzip ? createGunzip() : undefined;
  const stream = gunzip ? source.pipe(gunzip) : source;
  const fail = (error: Error) => stream.destroy(error);
  if (gzip) source.on('error', fail);
  const entries: ArchiveEntry[] = [];
  let header = Buffer.alloc(0);
  let remaining = 0;
  let extension: { kind: string; bytes: number; chunks: Buffer[] } | null = null;
  let global: Record<string, string> = {};
  let local: Record<string, string> = {};
  let ended = false;
  let zeroBlocks = 0;
  let expandedBytes = 0;
  let payloadBytes = 0;
  let currentEntry = false;
  let entryCount = 0;
  let headerCount = 0;
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      const data = chunk as Buffer;
      expandedBytes += data.length;
      if (expandedBytes > (options.maxExpandedBytes ?? Number.MAX_SAFE_INTEGER)) throw invalid();
      if (ended) {
        if (options.strict && data.some((byte) => byte !== 0)) throw invalid();
        continue;
      }
      let offset = 0;
      while (offset < data.length) {
        if (ended) {
          if (options.strict && data.subarray(offset).some((byte) => byte !== 0)) throw invalid();
          break;
        }
        if (remaining) {
          const count = Math.min(remaining, data.length - offset);
          if (extension?.bytes) {
            const used = Math.min(extension.bytes, count);
            extension.chunks.push(data.subarray(offset, offset + used));
            extension.bytes -= used;
          }
          if (currentEntry && payloadBytes) {
            const used = Math.min(payloadBytes, count);
            await options.onData?.(data.subarray(offset, offset + used));
            payloadBytes -= used;
          }
          remaining -= count;
          offset += count;
          if (!remaining && extension) {
            const payload = Buffer.concat(extension.chunks);
            if (extension.kind === 'g') global = { ...global, ...paxFields(payload, options.strict) };
            else if (extension.kind === 'x') local = { ...local, ...paxFields(payload, options.strict) };
            else local[extension.kind === 'L' ? 'path' : 'linkpath'] = text(payload).replace(/\n$/, '');
            extension = null;
          }
          if (!remaining && currentEntry) {
            await options.onEntryEnd?.();
            currentEntry = false;
          }
          continue;
        }
        const count = Math.min(512 - header.length, data.length - offset);
        header = Buffer.concat([header, data.subarray(offset, offset + count)]);
        offset += count;
        if (header.length < 512) continue;
        if (header.every((byte) => byte === 0)) {
          zeroBlocks++;
          header = Buffer.alloc(0);
          if (!options.strict || zeroBlocks >= 2) ended = true;
          continue;
        }
        if (options.strict && zeroBlocks) throw invalid();
        if (options.strict && ++headerCount > Math.min(Number.MAX_SAFE_INTEGER, (options.maxEntries ?? Number.MAX_SAFE_INTEGER) * 3 + 16))
          throw invalid();
        const checksum = sizeOf(header.subarray(148, 156));
        const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
        if (checksum !== actual) throw invalid();
        const kind = String.fromCharCode(header[156] || 48);
        const headerSize = sizeOf(header.subarray(124, 136));
        if (['x', 'g', 'L', 'K'].includes(kind)) {
          if (headerSize < 1 || headerSize > 1024 * 1024) throw invalid();
          extension = { kind, bytes: headerSize, chunks: [] };
          remaining = Math.ceil(headerSize / 512) * 512;
        } else {
          const fields = { ...global, ...local };
          const prefix = header.subarray(257, 263).toString('ascii') === 'ustar\0' ? text(header.subarray(345, 500)) : '';
          const name = text(header.subarray(0, 100));
          const path = fields.path ?? (prefix ? `${prefix}/${name}` : name);
          const linkTarget = fields.linkpath ?? text(header.subarray(157, 257));
          const type = kind === '0' || kind === '7' ? '-' : kind === '5' ? 'd' : kind === '2' ? 'l' : kind === '1' ? 'h' : kind;
          const size = fields.size === undefined ? headerSize : Number(fields.size);
          if (!Number.isSafeInteger(size) || size < 0 || !path || path.length > 4096 || linkTarget.length > 4096) throw invalid();
          if (options.strict && type === 'd' && size !== 0) throw invalid();
          if (entryCount++ >= (options.maxEntries ?? Number.MAX_SAFE_INTEGER) || size > (options.maxExpandedBytes ?? Number.MAX_SAFE_INTEGER))
            throw invalid();
          if (options.collectEntries !== false) entries.push({ path, type, ...(type === 'l' || type === 'h' ? { linkTarget } : {}) });
          await options.onEntry?.({ path, type, size, ...(type === 'l' || type === 'h' ? { linkTarget } : {}) });
          payloadBytes = size;
          currentEntry = true;
          remaining = Math.ceil(size / 512) * 512;
          if (!remaining) {
            await options.onEntryEnd?.();
            currentEntry = false;
          }
          local = {};
        }
        header = Buffer.alloc(0);
      }
    }
    if (!ended || remaining || extension || (options.strict && header.length)) throw invalid();
    if (options.strict && gunzip) {
      const stat = await fs.promises.stat(file);
      const consumed = gunzip.bytesWritten;
      if (!Number.isSafeInteger(consumed) || consumed > stat.size || stat.size - consumed > 1024 * 1024) throw invalid();
      if (consumed < stat.size) {
        const tail = fs.createReadStream(file, { start: consumed, signal });
        for await (const chunk of tail) if ((chunk as Buffer).some((byte) => byte !== 0)) throw invalid();
      }
    }
    return entries;
  } finally {
    source.removeListener('error', fail);
    stream.destroy();
    source.destroy();
  }
}

export const readTarMetadata = (file: string, gzip: boolean, signal?: AbortSignal) => readTarArchive(file, gzip, signal);
