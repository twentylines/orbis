import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getCliSecret, readCliSecret } from '../permissions-helpers';

let root: string;
const keyPath = () => path.join(root, '.secrets', 'cli-secret');
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-cli-key-'));
  await fs.chmod(root, 0o700);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

test('creates one durable private key for concurrent startup without changing existing encryption material', async () => {
  await fs.writeFile(path.join(root, 'encryption-fixture'), 'retained encryption fixture');
  const keys = await Promise.all(Array.from({ length: 20 }, () => getCliSecret(root)));
  expect(keys.every((key) => /^[a-f0-9]{64}$/.test(key))).toBe(true);
  expect(new Set(keys.map(hash)).size).toBe(1);
  expect(hash(readCliSecret(root) ?? '')).toBe(hash(keys[0] ?? ''));
  expect(await fs.readFile(path.join(root, 'encryption-fixture'), 'utf8')).toBe('retained encryption fixture');
  expect((await fs.stat(path.dirname(keyPath()))).mode & 0o7777).toBe(0o700);
  expect((await fs.stat(keyPath())).mode & 0o7777).toBe(0o600);
  expect((await fs.stat(keyPath())).nlink).toBe(1);
  const before = await fs.stat(keyPath());
  expect(hash(await getCliSecret(root))).toBe(hash(keys[0] ?? ''));
  const after = await fs.stat(keyPath());
  expect([after.ino, after.mtimeMs, after.ctimeMs]).toEqual([before.ino, before.mtimeMs, before.ctimeMs]);
});

test('readonly startup with no key creates no directory or key', async () => {
  const before = await fs.readdir(root);
  expect(readCliSecret(root)).toBeNull();
  expect(await fs.readdir(root)).toEqual(before);
});

test('rotates an exposed key without changing unrelated directory contents and reuses the replacement', async () => {
  const original = await getCliSecret(root);
  await fs.writeFile(path.join(root, '.secrets', 'retained'), 'retained fixture');
  await fs.chmod(keyPath(), 0o644);
  expect(() => readCliSecret(root)).toThrow('CLI authentication storage');
  const replacement = await getCliSecret(root);
  expect(hash(replacement)).not.toBe(hash(original));
  expect(hash(await getCliSecret(root))).toBe(hash(replacement));
  expect(await fs.readFile(path.join(root, '.secrets', 'retained'), 'utf8')).toBe('retained fixture');
});

test('repairs an exposed directory without discarding its still-private key', async () => {
  const original = await getCliSecret(root);
  await fs.chmod(path.join(root, '.secrets'), 0o755);
  expect(() => readCliSecret(root)).toThrow('CLI authentication storage');
  expect(hash(await getCliSecret(root))).toBe(hash(original));
  expect((await fs.stat(path.join(root, '.secrets'))).mode & 0o7777).toBe(0o700);
});

test.each(['partial', 'x'.repeat(64), 'A'.repeat(64), `${'a'.repeat(64)}\n`])(
  'preserves a malformed private key instead of adopting or replacing it (%#)',
  async (contents) => {
    await fs.mkdir(path.join(root, '.secrets'), { mode: 0o700 });
    await fs.writeFile(keyPath(), contents, { mode: 0o600 });
    const before = await fs.stat(keyPath());
    await expect(getCliSecret(root)).rejects.toThrow('CLI authentication storage');
    expect(() => readCliSecret(root)).toThrow('CLI authentication storage');
    expect(hash(await fs.readFile(keyPath(), 'utf8'))).toBe(hash(contents));
    expect((await fs.stat(keyPath())).ino).toBe(before.ino);
  },
);

test('refuses symlink and hardlink aliases without changing either target', async () => {
  const target = path.join(root, 'untouched');
  await fs.writeFile(target, 'untouched fixture');
  await fs.mkdir(path.join(root, '.secrets'), { mode: 0o700 });
  await fs.symlink(target, keyPath());
  await expect(getCliSecret(root)).rejects.toThrow();
  expect(() => readCliSecret(root)).toThrow('CLI authentication storage');
  await fs.unlink(keyPath());
  await fs.link(target, keyPath());
  await expect(getCliSecret(root)).rejects.toThrow('CLI authentication storage');
  expect(await fs.readFile(target, 'utf8')).toBe('untouched fixture');
});

test('refuses a symlinked secret directory without creating files through it', async () => {
  const target = path.join(root, 'untouched');
  await fs.mkdir(target);
  await fs.symlink(target, path.join(root, '.secrets'));
  await expect(getCliSecret(root)).rejects.toThrow('CLI authentication storage');
  expect(await fs.readdir(target)).toEqual([]);
});

test('refuses writable parent storage before allocating a key', async () => {
  await fs.chmod(root, 0o777);
  await expect(getCliSecret(root)).rejects.toThrow('CLI authentication storage');
  expect(await fs.readdir(root)).toEqual([]);
});

test('leaves no partial published key after a failed write, and retries the next startup', async () => {
  const open = fs.open.bind(fs);
  const failure = new Error('fixture write failure');
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const file = await open(...args);
    if (String(args[0]).includes('.cli-secret-')) vi.spyOn(file, 'writeFile').mockRejectedValueOnce(failure);
    return file;
  });
  await expect(getCliSecret(root)).rejects.toBe(failure);
  expect(readCliSecret(root)).toBeNull();
  expect(await fs.readdir(path.join(root, '.secrets'))).toEqual([]);
  spy.mockRestore();
  expect(/^[a-f0-9]{64}$/.test(await getCliSecret(root))).toBe(true);
});

test('retries durability after a failed directory sync without generating a second key', async () => {
  const open = fs.open.bind(fs);
  const failure = new Error('fixture directory sync failure');
  const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const file = await open(...args);
    if (String(args[0]) === path.join(root, '.secrets')) vi.spyOn(file, 'sync').mockRejectedValueOnce(failure);
    return file;
  });
  await expect(getCliSecret(root)).rejects.toBe(failure);
  const original = readCliSecret(root);
  expect(original !== null).toBe(true);
  spy.mockRestore();
  expect(hash(await getCliSecret(root))).toBe(hash(original ?? ''));
});
