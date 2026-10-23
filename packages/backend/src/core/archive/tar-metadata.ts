import fs from 'node:fs';
import { createGunzip } from 'node:zlib';

export type ArchiveEntry = { path: string; type: string; linkTarget?: string };
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

const paxFields = (data: Buffer) => {
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
    if (['path', 'linkpath', 'size'].includes(key)) {
      const value = record.slice(equal + 1);
      if (value.length > (key === 'size' ? 32 : 4096) || (key === 'size' && !/^(0|[1-9][0-9]*)$/.test(value))) throw invalid();
      fields[key] = value;
    }
    offset += length;
  }
  return fields;
};

export async function readTarMetadata(file: string, gzip: boolean, signal?: AbortSignal): Promise<ArchiveEntry[]> {
  const source = fs.createReadStream(file, { signal });
  const stream = gzip ? source.pipe(createGunzip()) : source;
  const fail = (error: Error) => stream.destroy(error);
  if (gzip) source.on('error', fail);
  const entries: ArchiveEntry[] = [];
  let header = Buffer.alloc(0);
  let remaining = 0;
  let extension: { kind: string; bytes: number; chunks: Buffer[] } | null = null;
  let global: Record<string, string> = {};
  let local: Record<string, string> = {};
  let ended = false;
  try {
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      if (ended) continue;
      const data = chunk as Buffer;
      let offset = 0;
      while (offset < data.length) {
        if (remaining) {
          const count = Math.min(remaining, data.length - offset);
          if (extension?.bytes) {
            const used = Math.min(extension.bytes, count);
            extension.chunks.push(data.subarray(offset, offset + used));
            extension.bytes -= used;
          }
          remaining -= count;
          offset += count;
          if (!remaining && extension) {
            const payload = Buffer.concat(extension.chunks);
            if (extension.kind === 'g') global = { ...global, ...paxFields(payload) };
            else if (extension.kind === 'x') local = { ...local, ...paxFields(payload) };
            else local[extension.kind === 'L' ? 'path' : 'linkpath'] = text(payload).replace(/\n$/, '');
            extension = null;
          }
          continue;
        }
        const count = Math.min(512 - header.length, data.length - offset);
        header = Buffer.concat([header, data.subarray(offset, offset + count)]);
        offset += count;
        if (header.length < 512) continue;
        if (header.every((byte) => byte === 0)) {
          ended = true;
          break;
        }
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
          entries.push({ path, type, ...(type === 'l' || type === 'h' ? { linkTarget } : {}) });
          remaining = Math.ceil(size / 512) * 512;
          local = {};
        }
        header = Buffer.alloc(0);
      }
    }
    if (!ended || remaining || extension) throw invalid();
    return entries;
  } finally {
    source.removeListener('error', fail);
    stream.destroy();
    source.destroy();
  }
}
