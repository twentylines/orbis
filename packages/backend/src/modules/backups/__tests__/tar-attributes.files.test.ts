import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTarArchive, type TarEntry } from '@/core/archive/tar-metadata';

const octal = (value: number, width: number) => Buffer.from(`${value.toString(8).padStart(width - 1, '0')}\0`);
const base256 = (value: bigint, width: number) => {
  const bytes = Buffer.alloc(width);
  let encoded = value < 0n ? (1n << BigInt(width * 8 - 1)) + value : value;
  for (let i = width - 1; i >= 0; i--) {
    bytes[i] = Number(encoded & 255n);
    encoded >>= 8n;
  }
  bytes[0] = (bytes[0] ?? 0) | 0x80;
  return bytes;
};
const header = (name: string, kind = '0', data = Buffer.alloc(0), fields: Record<number, Buffer> = {}) => {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100);
  octal(0o6754, 8).copy(block, 100);
  octal(123, 8).copy(block, 108);
  octal(456, 8).copy(block, 116);
  octal(data.length, 12).copy(block, 124);
  octal(123456, 12).copy(block, 136);
  block.fill(32, 148, 156);
  block.write(kind, 156);
  block.write('ustar\0', 257);
  for (const [offset, value] of Object.entries(fields)) value.copy(block, Number(offset));
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  block.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return Buffer.concat([block, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
};
const pax = (key: string, value: string) => {
  const record = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(record) + 1;
  while (String(length).length + Buffer.byteLength(record) !== length) length = String(length).length + Buffer.byteLength(record);
  return Buffer.from(`${length}${record}`);
};

describe('opt-in tar attributes', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-tar-attributes-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const save = async (...blocks: Buffer[]) => {
    const file = path.join(root, 'fixture.tar');
    await fs.writeFile(file, Buffer.concat([...blocks, Buffer.alloc(1024)]));
    return file;
  };
  it('preserves default shapes and exposes ordinary octal metadata in entries and callbacks', async () => {
    const file = await save(header('file'));
    const seen: TarEntry[] = [];
    expect(await readTarArchive(file, false)).toEqual([{ path: 'file', type: '-' }]);
    const attributes = { mode: 0o6754, uid: 123, gid: 456, mtime: 123456 };
    expect(
      await readTarArchive(file, false, undefined, {
        strict: true,
        attributes: true,
        onEntry: async (entry) => {
          seen.push(entry);
        },
      }),
    ).toEqual([{ path: 'file', type: '-', attributes }]);
    expect(seen).toEqual([{ path: 'file', type: '-', size: 0, attributes }]);
  });
  it('accepts bounded base256 including signed mtime', async () => {
    const file = await save(
      header('file', '0', undefined, { 100: base256(0o755n, 8), 108: base256(4294967295n, 8), 116: base256(9n, 8), 136: base256(-42n, 12) }),
    );
    expect(await readTarArchive(file, false, undefined, { attributes: true })).toEqual([
      { path: 'file', type: '-', attributes: { mode: 0o755, uid: 4294967295, gid: 9, mtime: -42 } },
    ]);
  });
  it('uses local PAX overrides over global values and header values', async () => {
    const file = await save(
      header('global', 'g', Buffer.concat([pax('uid', '12'), pax('gid', '34'), pax('mtime', '1.5')])),
      header('local', 'x', Buffer.concat([pax('uid', '99'), pax('mtime', '-123.25')])),
      header('file'),
      header('second'),
    );
    expect(await readTarArchive(file, false, undefined, { strict: true, attributes: true })).toEqual([
      { path: 'file', type: '-', attributes: { mode: 0o6754, uid: 99, gid: 34, mtime: -123.25 } },
      { path: 'second', type: '-', attributes: { mode: 0o6754, uid: 12, gid: 34, mtime: 1.5 } },
    ]);
  });
  it.each([
    [100, Buffer.from('0008888\0')],
    [100, octal(0o10000, 8)],
    [108, base256(-1n, 8)],
    [116, base256(4294967296n, 8)],
    [136, base256(8640000000001n, 12)],
    [136, base256(-8640000000001n, 12)],
  ])('rejects invalid header attribute at %s', async (offset, bytes) => {
    const file = await save(header('file', '0', undefined, { [offset]: bytes }));
    await expect(readTarArchive(file, false, undefined, { attributes: true })).rejects.toThrow('Invalid backup archive');
  });
  it.each([
    ['uid', '-1'],
    ['gid', '4294967296'],
    ['uid', '1e2'],
    ['mtime', 'Infinity'],
    ['mtime', '-8640000000000.1'],
    ['mtime', '1.'],
  ])('rejects invalid PAX %s=%s', async (key, value) => {
    const file = await save(header('pax', 'x', pax(key, value)), header('file'));
    await expect(readTarArchive(file, false, undefined, { strict: true, attributes: true })).rejects.toThrow('Invalid backup archive');
  });
  it('rejects duplicate PAX attributes and malformed underlying headers even when overridden', async () => {
    const duplicate = await save(header('pax', 'x', Buffer.concat([pax('uid', '1'), pax('uid', '2')])), header('file'));
    await expect(readTarArchive(duplicate, false, undefined, { strict: true, attributes: true })).rejects.toThrow('Invalid backup archive');
    const malformed = await save(header('pax', 'x', pax('uid', '1')), header('file', '0', undefined, { 108: Buffer.from('invalid\0') }));
    await expect(readTarArchive(malformed, false, undefined, { attributes: true })).rejects.toThrow('Invalid backup archive');
  });
});
