import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { backupMetadataBytes } from './backup-crypto';
import { exportSettingsBundle, importSettingsBundle } from './settings-backup-format';
import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from './darwin-files.fixture';

let root: string;
let restore: () => void;
const passphrase = 'example passphrase';
const signal = new AbortController().signal;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Private TMPDIR required');
  root = await fs.mkdtemp(path.join(process.env.TMPDIR, 'settings-codec-'));
  restore = stabilizeDarwinFixtureCreation(() => root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  restore();
  await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const settings = await backupMetadataBytes(Buffer.from('{"theme":"dark"}'), passphrase, false);
  const tm = Buffer.from('opaque preencrypted time machine fixture');
  const a = path.join(root, 'settings');
  const b = path.join(root, 'tm');
  await fs.writeFile(a, settings, { mode: 0o600 });
  await fs.writeFile(b, tm, { mode: 0o600 });
  stabilizeExistingDarwinFixtures(root);
  const parts = [
    { kind: 'settings' as const, id: null, file: a, bytes: settings.length, sha256: sha256(settings) },
    { kind: 'time-machine' as const, id: randomUUID(), file: b, bytes: tm.length, sha256: sha256(tm) },
  ];
  const destination = path.join(root, 'bundle');
  const options = {
    destination,
    directory: path.join(root, 'export'),
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    orbisVersion: '1.0.0',
    passphrase,
    parts,
    signal,
  };
  return { settings, tm, options, destination };
}
it('round trips encrypted settings and opaque capture bytes without applying them', async () => {
  const f = await fixture();
  const exported = await exportSettingsBundle(f.options);
  const archive = await fs.readFile(f.destination);
  expect(exported.sha256).toBe(sha256(archive));
  expect(archive.includes(Buffer.from('theme'))).toBe(false);
  const imported = await importSettingsBundle({ source: f.destination, directory: path.join(root, 'import'), passphrase, signal });
  expect(imported.manifest).toEqual(exported.manifest);
  if (!imported.parts[0] || !imported.parts[1]) throw new Error('Missing parts');
  expect(await fs.readFile(imported.parts[0].file)).toEqual(f.settings);
  expect(await fs.readFile(imported.parts[1].file)).toEqual(f.tm);
  await imported.dispose();
  await expect(fs.stat(path.join(root, 'import'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects non-private and linked staging parents before allocating a work directory', async () => {
  const f = await fixture();
  const parent = path.join(root, 'public');
  await fs.mkdir(parent, { mode: 0o755 });
  const directory = path.join(parent, 'work');
  await expect(exportSettingsBundle({ ...f.options, directory })).rejects.toThrow();
  await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.chmod(parent, 0o700);
  const alias = path.join(root, 'alias');
  await fs.symlink(parent, alias);
  await expect(exportSettingsBundle({ ...f.options, directory: path.join(alias, 'work') })).rejects.toThrow();
  await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps storage reserve and does not publish when capacity is insufficient', async () => {
  const f = await fixture();
  vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 0n, bsize: 4096n } as never);
  await expect(exportSettingsBundle(f.options)).rejects.toThrow();
  await expect(fs.lstat(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(f.options.parts[1]?.file ?? '')).toEqual(f.tm);
});

it('preserves an unexpected replacement work directory instead of deleting it during cleanup', async () => {
  const f = await fixture();
  const original = fs.link.bind(fs);
  const retained = `${f.options.directory}-retained`;
  vi.spyOn(fs, 'link').mockImplementationOnce(async (...args: Parameters<typeof fs.link>) => {
    await fs.rename(f.options.directory, retained);
    await fs.mkdir(f.options.directory, { mode: 0o700 });
    await fs.writeFile(path.join(f.options.directory, 'keep'), 'unrelated replacement');
    return original(...args);
  });
  await expect(exportSettingsBundle(f.options)).rejects.toThrow();
  expect(await fs.readFile(path.join(f.options.directory, 'keep'), 'utf8')).toBe('unrelated replacement');
  expect((await fs.lstat(retained)).isDirectory()).toBe(true);
});
it('rejects wrong passwords and corruption, and cleans only fresh staging', async () => {
  const f = await fixture();
  await exportSettingsBundle(f.options);
  const dir = path.join(root, 'import');
  await expect(importSettingsBundle({ source: f.destination, directory: dir, passphrase: 'incorrect password', signal })).rejects.toThrow();
  await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  const data = await fs.readFile(f.destination);
  const at = data.indexOf(f.tm);
  expect(at).toBeGreaterThan(0);
  data[at] = (data[at] ?? 0) ^ 1;
  await fs.writeFile(f.destination, data, { mode: 0o600 });
  await expect(importSettingsBundle({ source: f.destination, directory: dir, passphrase, signal })).rejects.toThrow();
});
it('rejects stale staging, existing destination, duplicate selection, unsafe sources and cancellation', async () => {
  const f = await fixture();
  await fs.mkdir(f.options.directory, { mode: 0o700 });
  await fs.writeFile(path.join(f.options.directory, 'keep'), 'keep');
  await expect(exportSettingsBundle(f.options)).rejects.toThrow();
  expect(await fs.readFile(path.join(f.options.directory, 'keep'), 'utf8')).toBe('keep');
  await fs.rm(f.options.directory, { recursive: true });
  await fs.writeFile(f.destination, 'keep', { mode: 0o600 });
  await expect(exportSettingsBundle(f.options)).rejects.toThrow();
  expect(await fs.readFile(f.destination, 'utf8')).toBe('keep');
  await fs.unlink(f.destination);
  const part = f.options.parts[0];
  if (!part) throw new Error('Missing part');
  await expect(exportSettingsBundle({ ...f.options, parts: [part, part] })).rejects.toThrow();
  await fs.chmod(part.file, 0o644);
  await expect(exportSettingsBundle(f.options)).rejects.toThrow();
  await fs.chmod(part.file, 0o600);
  const link = path.join(root, 'link');
  await fs.symlink(part.file, link);
  await expect(exportSettingsBundle({ ...f.options, parts: [{ ...part, file: link }] })).rejects.toThrow();
  const abort = new AbortController();
  abort.abort();
  await expect(exportSettingsBundle({ ...f.options, signal: abort.signal })).rejects.toThrow();
});

it('rejects omitted, duplicate, traversing, linked and trailing archive members', async () => {
  const f = await fixture();
  await exportSettingsBundle(f.options);
  const original = await fs.readFile(f.destination);
  const headers: number[] = [];
  for (let i = 0; i + 512 <= original.length; i += 512) {
    const name =
      original
        .subarray(i, i + 100)
        .toString('utf8')
        .split('\0')[0] ?? '';
    if (/^\.\/parts\/[0-9a-f-]{36}\.orbis$/.test(name)) headers.push(i);
  }
  expect(headers).toHaveLength(2);
  const first = headers[0] ?? 0;
  const second = headers[1] ?? 0;
  const checksum = (buffer: Buffer, offset: number) => {
    buffer.fill(32, offset + 148, offset + 156);
    const sum = buffer.subarray(offset, offset + 512).reduce((a, b) => a + b, 0);
    buffer.write(`${sum.toString(8).padStart(6, '0')}\0 `, offset + 148, 'ascii');
  };
  for (const mutation of ['omission', 'duplicate', 'traversal', 'link', 'trailing']) {
    let data = Buffer.from(original);
    if (mutation === 'omission') {
      data.fill(0, second, second + 100);
      data.write('./unknown', second);
      checksum(data, second);
    }
    if (mutation === 'duplicate') {
      data.copy(data, second, first, first + 100);
      checksum(data, second);
    }
    if (mutation === 'traversal') {
      data.fill(0, second, second + 100);
      data.write('../escape', second);
      checksum(data, second);
    }
    if (mutation === 'link') {
      data[second + 156] = 50;
      checksum(data, second);
    }
    if (mutation === 'trailing') data = Buffer.concat([data, Buffer.from('junk')]);
    await fs.writeFile(f.destination, data, { mode: 0o600 });
    await expect(importSettingsBundle({ source: f.destination, directory: path.join(root, 'import'), passphrase, signal })).rejects.toThrow();
    await expect(fs.stat(path.join(root, 'import'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});
