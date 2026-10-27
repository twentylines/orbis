import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BackupArchiveError, decryptBackup, encryptBackup } from './backup-crypto';

const passphrase = 'disposable-backup-passphrase';
let directory: string;
let source: string;
let archive: string;
let restored: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-full-backup-'));
  source = path.join(directory, 'source.tar.gz');
  archive = path.join(directory, 'saved.orbis-backup');
  restored = path.join(directory, 'restored.tar.gz');
  await fs.writeFile(source, 'application data and saved configuration', { mode: 0o600 });
});
afterEach(async () => fs.rm(directory, { recursive: true, force: true }));

it.each([0, 128, 4 * 1024 * 1024])('round-trips %i bytes without changing data and reports measured progress', async (size) => {
  const data = randomBytes(size);
  await fs.writeFile(source, data);
  const progress: number[] = [];
  const encrypted = await encryptBackup({
    source,
    destination: archive,
    passphrase,
    onProgress: (done, total) => {
      progress.push(done);
      expect(total).toBe(size);
    },
  });
  expect(encrypted.processedBytes).toBe(size);
  expect(progress.at(-1)).toBe(size);
  expect(progress).toEqual([...progress].sort((a, b) => a - b));
  expect((await fs.stat(archive)).mode & 0o777).toBe(0o600);
  await decryptBackup({ source: archive, destination: restored, passphrase });
  expect(
    createHash('sha256')
      .update(await fs.readFile(restored))
      .digest('hex'),
  ).toBe(createHash('sha256').update(data).digest('hex'));
  expect((await fs.stat(restored)).mode & 0o777).toBe(0o600);
  expect((await fs.readdir(directory)).filter((name) => name.endsWith('.partial'))).toEqual([]);
});

it('uses independent salt and nonce for each encrypted archive', async () => {
  const another = path.join(directory, 'another.orbis-backup');
  await encryptBackup({ source, destination: archive, passphrase });
  await encryptBackup({ source, destination: another, passphrase });
  expect(await fs.readFile(archive)).not.toEqual(await fs.readFile(another));
});

it('publishes no plaintext destination when the passphrase is incorrect', async () => {
  await encryptBackup({ source, destination: archive, passphrase });
  await expect(decryptBackup({ source: archive, destination: restored, passphrase: 'different-disposable-passphrase' })).rejects.toMatchObject({
    code: 'invalid-archive',
  });
  await expect(fs.stat(restored)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.readdir(directory)).filter((name) => name.endsWith('.partial'))).toEqual([]);
});

it.each(['header', 'ciphertext', 'tag', 'truncated'] as const)('rejects a changed %s before publishing a restore file', async (part) => {
  await encryptBackup({ source, destination: archive, passphrase });
  const bytes = await fs.readFile(archive);
  if (part === 'truncated') await fs.writeFile(archive, bytes.subarray(0, bytes.length - 3));
  else {
    const index = part === 'header' ? 10 : part === 'ciphertext' ? 40 : bytes.length - 1;
    bytes.writeUInt8(bytes.readUInt8(index) ^ 1, index);
    await fs.writeFile(archive, bytes);
  }
  await expect(decryptBackup({ source: archive, destination: restored, passphrase })).rejects.toBeInstanceOf(BackupArchiveError);
  await expect(fs.stat(restored)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not overwrite an existing file or follow a destination symlink', async () => {
  await fs.writeFile(archive, 'keep existing file');
  await expect(encryptBackup({ source, destination: archive, passphrase })).rejects.toMatchObject({ code: 'operation-failed' });
  expect(await fs.readFile(archive, 'utf8')).toBe('keep existing file');
  const link = path.join(directory, 'link');
  await fs.symlink(archive, link);
  await expect(encryptBackup({ source, destination: link, passphrase })).rejects.toMatchObject({ code: 'operation-failed' });
  expect(await fs.readFile(archive, 'utf8')).toBe('keep existing file');
});

it('refuses source symlinks and public plaintext staging directories', async () => {
  const link = path.join(directory, 'source-link');
  await fs.symlink(source, link);
  await expect(encryptBackup({ source: link, destination: archive, passphrase })).rejects.toMatchObject({ code: 'operation-failed' });
  await fs.chmod(directory, 0o755);
  await expect(encryptBackup({ source, destination: archive, passphrase })).rejects.toMatchObject({ code: 'operation-failed' });
});

it('cancels a streaming operation and removes its incomplete output', async () => {
  await fs.writeFile(source, randomBytes(2 * 1024 * 1024));
  const controller = new AbortController();
  await expect(
    encryptBackup({
      source,
      destination: archive,
      passphrase,
      signal: controller.signal,
      onProgress: (done) => {
        if (done) controller.abort();
      },
    }),
  ).rejects.toMatchObject({ code: 'cancelled' });
  await expect(fs.stat(archive)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.readdir(directory)).filter((name) => name.endsWith('.partial'))).toEqual([]);
});

it.each(['', 'too short', ' '.repeat(20), 'x'.repeat(1025)])('rejects an unusable passphrase without echoing it', async (value) => {
  await expect(encryptBackup({ source, destination: archive, passphrase: value })).rejects.toMatchObject({ code: 'passphrase' });
  expect((await fs.readdir(directory)).filter((name) => name.endsWith('.partial'))).toEqual([]);
});

it('does not include source paths or underlying errors in failure messages', async () => {
  const privatePath = path.join(directory, 'missing-source');
  await expect(encryptBackup({ source: privatePath, destination: archive, passphrase })).rejects.toMatchObject({
    message: expect.not.stringContaining(privatePath),
  });
});

it('keeps an existing restore destination intact and reports a storage conflict', async () => {
  await encryptBackup({ source, destination: archive, passphrase });
  await fs.writeFile(restored, 'keep this file');
  await expect(decryptBackup({ source: archive, destination: restored, passphrase })).rejects.toMatchObject({ code: 'operation-failed' });
  expect(await fs.readFile(restored, 'utf8')).toBe('keep this file');
});

it('refuses to commit an archive when its input changes during encryption', async () => {
  await expect(
    encryptBackup({
      source,
      destination: archive,
      passphrase,
      onProgress: (done) => {
        if (done) appendFileSync(source, 'changed');
      },
    }),
  ).rejects.toMatchObject({ code: 'operation-failed' });
  await expect(fs.stat(archive)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('removes unverified plaintext when a restore is cancelled', async () => {
  await fs.writeFile(source, randomBytes(2 * 1024 * 1024));
  await encryptBackup({ source, destination: archive, passphrase });
  const controller = new AbortController();
  await expect(
    decryptBackup({
      source: archive,
      destination: restored,
      passphrase,
      signal: controller.signal,
      onProgress: (done) => {
        if (done) controller.abort();
      },
    }),
  ).rejects.toMatchObject({ code: 'cancelled' });
  await expect(fs.stat(restored)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.readdir(directory)).filter((name) => name.endsWith('.partial'))).toEqual([]);
});
