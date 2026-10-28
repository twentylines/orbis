import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeRestoreEnvironment } from './backup-restore-environment';

let root: string;
const original = Buffer.from('DATABASE=original-fixture\nHOST=private-fixture\n');
const incoming = Buffer.from('DATABASE=restored\n');
let options: Parameters<typeof writeRestoreEnvironment>[0];
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-environment-')));
  await fs.mkdir(path.join(root, 'journal'), { mode: 0o700 });
  options = {
    file: path.join(root, 'configuration'),
    journal: path.join(root, 'journal', 'environment-pointer.json'),
    id: randomUUID(),
    nonce: randomUUID(),
    original,
    incoming,
    target: 'incoming',
  };
  await fs.writeFile(options.file, original, { mode: 0o600 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

it('changes and restores a file-bind configuration without changing its inode or leaking values into the intent', async () => {
  const before = await fs.stat(options.file);
  await writeRestoreEnvironment(options);
  expect(await fs.readFile(options.file)).toEqual(incoming);
  expect((await fs.stat(options.file)).ino).toBe(before.ino);
  const intent = await fs.readFile(options.journal, 'utf8');
  expect(JSON.parse(intent)).toMatchObject({ phase: 'settled', target: 'incoming', inode: String(before.ino) });
  expect(intent).not.toContain('DATABASE=');
  await writeRestoreEnvironment({ ...options, target: 'original' });
  expect(await fs.readFile(options.file)).toEqual(original);
  expect((await fs.stat(options.file)).ino).toBe(before.ino);
});

it.each(['writev', 'truncate', 'sync'] as const)('recovers an interrupted %s from the durable intent', async (stage) => {
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (String(file) === options.file) {
      if (stage === 'writev') {
        const write = handle.writev.bind(handle);
        vi.spyOn(handle, 'writev').mockImplementationOnce(async (buffers, position) => {
          const first = buffers[0];
          if (!first) throw new Error('Missing fixture write buffer');
          const bytes = Buffer.from(first.buffer, first.byteOffset, first.byteLength);
          await write([bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2)))], position);
          throw new Error('Disposable interrupted write');
        });
      } else vi.spyOn(handle, stage).mockRejectedValueOnce(new Error('Disposable interrupted operation'));
    }
    return handle;
  });
  await expect(writeRestoreEnvironment(options)).rejects.toThrow('recovery needs attention');
  expect(JSON.parse(await fs.readFile(options.journal, 'utf8')).phase).toBe('writing');
  vi.restoreAllMocks();
  await writeRestoreEnvironment(options);
  expect(await fs.readFile(options.file)).toEqual(incoming);
  expect(JSON.parse(await fs.readFile(options.journal, 'utf8')).phase).toBe('settled');
});

it('can roll back an interrupted incoming write using the same recorded identity', async () => {
  await writeRestoreEnvironment(options);
  const intent = JSON.parse(await fs.readFile(options.journal, 'utf8'));
  await fs.writeFile(options.journal, JSON.stringify({ ...intent, phase: 'writing' }), { mode: 0o600 });
  await fs.writeFile(options.file, incoming.subarray(0, 4));
  await writeRestoreEnvironment({ ...options, target: 'original' });
  expect(await fs.readFile(options.file)).toEqual(original);
});

it('does not start writing when the intent cannot be synchronized', async () => {
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (String(file) === path.dirname(options.journal)) vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('Disposable directory failure'));
    return handle;
  });
  await expect(writeRestoreEnvironment(options)).rejects.toThrow('recovery needs attention');
  expect(await fs.readFile(options.file)).toEqual(original);
});

it.each(['unknown-content', 'replaced-inode', 'foreign-job', 'changed-source', 'hard-link', 'symlink', 'public-mode'] as const)(
  'refuses %s without overwriting the current file',
  async (failure) => {
    if (['replaced-inode', 'foreign-job', 'changed-source'].includes(failure)) await writeRestoreEnvironment(options);
    if (failure === 'unknown-content') await fs.writeFile(options.file, 'unreviewed content');
    if (failure === 'replaced-inode') {
      await fs.rename(options.file, path.join(root, 'retained'));
      await fs.writeFile(options.file, incoming, { mode: 0o600 });
    }
    if (failure === 'foreign-job') options = { ...options, nonce: randomUUID() };
    if (failure === 'changed-source') options = { ...options, incoming: Buffer.from('DATABASE=other-fixture\n') };
    if (failure === 'hard-link') await fs.link(options.file, path.join(root, 'linked'));
    if (failure === 'symlink') {
      await fs.rename(options.file, path.join(root, 'retained'));
      await fs.symlink(path.join(root, 'retained'), options.file);
    }
    if (failure === 'public-mode') await fs.chmod(options.file, 0o644);
    const before = await fs.readFile(options.file);
    await expect(writeRestoreEnvironment(options)).rejects.toThrow('recovery needs attention');
    expect(await fs.readFile(options.file)).toEqual(before);
  },
);

it('snapshots caller buffers before asynchronous work', async () => {
  const bytes = Buffer.from(incoming);
  const pending = writeRestoreEnvironment({ ...options, incoming: bytes });
  bytes.fill(0);
  await pending;
  expect(await fs.readFile(options.file)).toEqual(incoming);
});

it('refuses oversized input before allocating an intent or changing the file', async () => {
  await expect(writeRestoreEnvironment({ ...options, incoming: Buffer.alloc(1024 * 1024 + 1) })).rejects.toThrow();
  await expect(fs.lstat(options.journal)).rejects.toHaveProperty('code', 'ENOENT');
  expect(await fs.readFile(options.file)).toEqual(original);
});
