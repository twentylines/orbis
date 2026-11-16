import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readTarArchive } from '../../core/archive/tar-metadata';
import { resetSafetyTarHeader, writeResetSafetyTar } from './reset-safety-tar';
import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from './darwin-files.fixture';

let root: string;
let restore: () => void;
const signal = () => new AbortController().signal;
const sha = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'reset-tar-')));
  restore = stabilizeDarwinFixtureCreation(() => root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  restore();
  await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const file = path.join(root, 'source');
  const data = Buffer.alloc(600_013, 41);
  await fs.writeFile(file, data, { mode: 0o600 });
  await fs.mkdir(path.join(root, 'output'), { mode: 0o700 });
  stabilizeExistingDarwinFixtures(root);
  return {
    file,
    data,
    destination: path.join(root, 'output', 'archive'),
    entries: [
      { name: 'bundle.json', data: Buffer.from('opaque index') },
      { name: 'parts/source.orbis', file, bytes: data.length, sha256: sha(data) },
      { name: 'parts/empty.orbis', data: Buffer.alloc(0) },
    ],
  };
}

it('streams exact members into a strict readable tar with honest progress and no duplicate staging copy', async () => {
  const f = await fixture();
  const progress: number[] = [];
  const result = await writeResetSafetyTar({
    ...f,
    signal: signal(),
    progress: (done, total) => {
      progress.push(done);
      expect(done).toBeLessThanOrEqual(total);
    },
  });
  const archive = await fs.readFile(f.destination);
  expect(result).toEqual({ bytes: archive.length, sha256: sha(archive) });
  expect(progress.every((value, index) => index === 0 || value >= (progress[index - 1] ?? 0))).toBe(true);
  const contents = new Map<string, Buffer>();
  let current = '';
  await readTarArchive(f.destination, false, signal(), {
    strict: true,
    onEntry: async (entry) => {
      current = entry.path;
      contents.set(current, Buffer.alloc(0));
    },
    onData: async (data) => {
      contents.set(current, Buffer.concat([contents.get(current) ?? Buffer.alloc(0), data]));
    },
  });
  expect(contents.get('parts/source.orbis')).toEqual(f.data);
  expect(contents.get('parts/empty.orbis')).toEqual(Buffer.alloc(0));
  expect(await fs.readdir(path.dirname(f.destination))).toEqual(['archive']);
  expect((await fs.lstat(f.file)).nlink).toBe(1);
});

it('encodes both standard and large-file tar sizes without losing integer precision', () => {
  for (const size of [0, 1, 512, 0o77777777777, 0o77777777777 + 1, 2 * 1024 ** 4]) {
    const header = resetSafetyTarHeader('parts/file.orbis', size);
    const field = header.subarray(124, 136);
    let value: bigint;
    if ((field[0] ?? 0) & 0x80) {
      value = BigInt((field[0] ?? 0) & 0x7f);
      for (const byte of field.subarray(1)) value = value * 256n + BigInt(byte);
    } else value = BigInt(`0o${field.toString('ascii').replace(/\0.*$/, '')}`);
    expect(value).toBe(BigInt(size));
    const checksum = Number.parseInt(header.subarray(148, 154).toString('ascii'), 8);
    const copy = Buffer.from(header);
    copy.fill(32, 148, 156);
    expect(copy.reduce((sum, byte) => sum + byte, 0)).toBe(checksum);
  }
  for (const name of ['../escape', '/absolute', 'parts//empty', 'parts/./bad', 'non-ascii-π']) expect(() => resetSafetyTarHeader(name, 1)).toThrow();
});

it('writes and independently reads the complete v2 member budget while retaining the default limit', async () => {
  const f = await fixture();
  const entries = Array.from({ length: 32_099 }, (_, index) => ({ name: `parts/member-${index}`, data: Buffer.alloc(0) }));
  await expect(writeResetSafetyTar({ ...f, entries, signal: signal() })).rejects.toThrow();
  await expect(writeResetSafetyTar({ ...f, entries, maxEntries: 32_100, signal: signal() })).rejects.toThrow();
  expect(await fs.readdir(path.dirname(f.destination))).toEqual([]);
  const saved = await writeResetSafetyTar({ ...f, entries, maxEntries: 32_099, signal: signal() });
  let count = 0;
  await readTarArchive(f.destination, false, signal(), {
    strict: true,
    maxEntries: 32_099,
    collectEntries: false,
    onEntry: async (entry) => {
      expect(entry.path).toBe(`parts/member-${count++}`);
      expect(entry.size).toBe(0);
    },
  });
  expect(count).toBe(32_099);
  expect(saved.bytes).toBe(32_099 * 512 + 1024);
  expect(saved.sha256).toBe(sha(await fs.readFile(f.destination)));
}, 20_000);

it('refuses corrupt commitments, existing destinations and unavailable capacity without publishing partial files', async () => {
  const f = await fixture();
  await expect(
    writeResetSafetyTar({ ...f, entries: [{ name: 'parts/file', file: f.file, bytes: f.data.length, sha256: '0'.repeat(64) }], signal: signal() }),
  ).rejects.toThrow();
  expect(await fs.readdir(path.dirname(f.destination))).toEqual([]);
  await fs.writeFile(f.destination, 'preserve existing', { mode: 0o600 });
  await expect(writeResetSafetyTar({ ...f, signal: signal() })).rejects.toThrow();
  expect(await fs.readFile(f.destination, 'utf8')).toBe('preserve existing');
  await fs.unlink(f.destination);
  vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 0n, bsize: 4096n } as never);
  await expect(writeResetSafetyTar({ ...f, signal: signal() })).rejects.toThrow();
  expect(await fs.readdir(path.dirname(f.destination))).toEqual([]);
});

it('refuses non-private, aliased and non-regular inputs without blocking on a FIFO', async () => {
  const f = await fixture();
  await fs.chmod(f.file, 0o644);
  await expect(writeResetSafetyTar({ ...f, signal: signal() })).rejects.toThrow();
  await fs.chmod(f.file, 0o600);
  const alias = path.join(root, 'alias');
  await fs.symlink(f.file, alias);
  const member = { name: 'parts/file', file: alias, bytes: f.data.length, sha256: sha(f.data) };
  await expect(writeResetSafetyTar({ ...f, entries: [member], signal: signal() })).rejects.toThrow();
  const fifo = path.join(root, 'fifo');
  await promisify(execFile)('mkfifo', ['-m', '600', fifo]);
  await expect(writeResetSafetyTar({ ...f, entries: [{ ...member, file: fifo }], signal: signal() })).rejects.toThrow();
  expect(await fs.readdir(path.dirname(f.destination))).toEqual([]);
});

it('detects a source-name replacement after reading and preserves the replacement', async () => {
  const f = await fixture();
  const lstat = fs.lstat.bind(fs);
  let changed = false;
  vi.spyOn(fs, 'lstat').mockImplementation((async (file, ...args) => {
    if (String(file) === f.file && !changed) {
      changed = true;
      await fs.rename(f.file, `${f.file}.old`);
      await fs.writeFile(f.file, 'preserve replacement', { mode: 0o600 });
    }
    return lstat(file, ...args);
  }) as typeof fs.lstat);
  await expect(writeResetSafetyTar({ ...f, signal: signal() })).rejects.toThrow();
  expect(changed).toBe(true);
  expect(await fs.readFile(f.file, 'utf8')).toBe('preserve replacement');
  expect(await fs.readdir(path.dirname(f.destination))).toEqual([]);
});

it('preserves an unexpected replacement staging directory and cancels without publishing', async () => {
  const f = await fixture();
  const link = fs.link.bind(fs);
  const parent = path.dirname(f.destination);
  vi.spyOn(fs, 'link').mockImplementationOnce(async (from, to) => {
    await fs.rename(parent, `${parent}.old`);
    await fs.mkdir(parent, { mode: 0o700 });
    await fs.writeFile(path.join(parent, 'keep'), 'preserve', { mode: 0o600 });
    return link(from, to);
  });
  await expect(writeResetSafetyTar({ ...f, signal: signal() })).rejects.toThrow();
  expect(await fs.readFile(path.join(parent, 'keep'), 'utf8')).toBe('preserve');
  const controller = new AbortController();
  controller.abort();
  await expect(writeResetSafetyTar({ ...f, signal: controller.signal })).rejects.toThrow();
});
