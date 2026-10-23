import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTarMetadata } from '@/core/archive/tar-metadata';

const header = (name: string, type = '0', data = Buffer.alloc(0), target = '') => {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100);
  block.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
  block.fill(32, 148, 156);
  block.write(type, 156);
  block.write(target, 157, 100);
  block.write('ustar\0', 257);
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return Buffer.concat([block, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
};
const pax = (name: string, value: string) => {
  const record = ` ${name}=${value}\n`;
  let length = Buffer.byteLength(record) + 1;
  while (String(length).length + Buffer.byteLength(record) !== length) length = String(length).length + Buffer.byteLength(record);
  return Buffer.from(`${length}${record}`);
};

describe('bounded structured tar metadata', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp('/tmp/orbis-tar-metadata-');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const save = async (blocks: Buffer[], compressed = false) => {
    const file = path.join(root, compressed ? 'test.tar.gz' : 'test.tar');
    const body = Buffer.concat([...blocks, Buffer.alloc(1024)]);
    await fs.writeFile(file, compressed ? gzipSync(body) : body);
    return file;
  };
  it.each([false, true])('reads exact link targets and skips file payload across stream chunks (gzip=%s)', async (compressed) => {
    const file = await save(
      [header('app-data/payload', '0', Buffer.alloc(70_000, 97)), header('app-data/link -> display', '2', undefined, 'payload')],
      compressed,
    );
    expect(await readTarMetadata(file, compressed)).toEqual([
      { path: 'app-data/payload', type: '-' },
      { path: 'app-data/link -> display', type: 'l', linkTarget: 'payload' },
    ]);
  });
  it('reads PAX Unicode paths and link targets independently of display quoting', async () => {
    const name = `app-data/${'long '.repeat(25)}链接`;
    const target = `${'target '.repeat(20)}é`;
    const file = await save([header('PaxHeader', 'x', Buffer.concat([pax('path', name), pax('linkpath', target)])), header('short', '2')]);
    expect(await readTarMetadata(file, false)).toEqual([{ path: name, type: 'l', linkTarget: target }]);
  });
  it('reads GNU long names and link names', async () => {
    const name = `app-data/${'x'.repeat(120)}`;
    const target = 'target'.repeat(30);
    const file = await save([
      header('././@LongLink', 'L', Buffer.from(`${name}\0`)),
      header('././@LongLink', 'K', Buffer.from(`${target}\0`)),
      header('short', '2'),
    ]);
    expect(await readTarMetadata(file, false)).toEqual([{ path: name, type: 'l', linkTarget: target }]);
  });
  it('rejects corrupt checksums, truncated payloads and malformed extended headers', async () => {
    const corrupt = header('app-data/file');
    corrupt[0] = 0;
    for (const blocks of [[corrupt], [header('PaxHeader', 'x', Buffer.from('999 path=missing\n'))]]) {
      await expect(readTarMetadata(await save(blocks), false)).rejects.toThrow('Invalid backup archive');
    }
    const file = path.join(root, 'truncated.tar');
    await fs.writeFile(file, header('app-data/payload', '0', Buffer.alloc(1024)).subarray(0, 600));
    await expect(readTarMetadata(file, false)).rejects.toThrow('Invalid backup archive');
  });
  it('honors cancellation before reading an archive', async () => {
    await expect(readTarMetadata(await save([header('app-data/file')]), false, AbortSignal.abort())).rejects.toThrow();
  });
  it('validates the gzip trailer after the logical tar end instead of returning early', async () => {
    const file = await save([header('app-data/file')], true);
    const bytes = await fs.readFile(file);
    bytes[bytes.length - 8] = (bytes[bytes.length - 8] ?? 0) ^ 1;
    await fs.writeFile(file, bytes);
    await expect(readTarMetadata(file, true)).rejects.toThrow();
  });
  it('rejects overlong extended paths and ignores unrelated global attributes without retaining them', async () => {
    const oversized = await save([header('PaxHeader', 'g', pax('path', 'x'.repeat(4097))), header('app-data/file')]);
    await expect(readTarMetadata(oversized, false)).rejects.toThrow('Invalid backup archive');
    const fields = Array.from({ length: 1000 }, (_, index) => pax(`vendor.key${index}`, 'x'.repeat(100)));
    const file = await save([header('PaxHeader', 'g', Buffer.concat(fields)), header('app-data/file')]);
    expect(await readTarMetadata(file, false)).toEqual([{ path: 'app-data/file', type: '-' }]);
  });
});
