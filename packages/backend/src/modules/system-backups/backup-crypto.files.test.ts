import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { backupGcmPlaintextLimit, encryptBackupStream, BackupArchiveError, decryptBackup, encryptBackup, backupMetadataBytes } from './backup-crypto';

const passphrase = 'disposable-backup-passphrase';
let directory: string;
let source: string;
let archive: string;
let restored: string;
beforeEach(async () => {
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-full-backup-')));
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

it.each(['', 'x'.repeat(7), ' '.repeat(20), 'x'.repeat(1025)])('rejects an unusable passphrase without echoing it', async (value) => {
  await expect(encryptBackup({ source, destination: archive, passphrase: value })).rejects.toMatchObject({ code: 'passphrase' });
  await expect(decryptBackup({ source: archive, destination: restored, passphrase: value })).rejects.toMatchObject({ code: 'passphrase' });
  await expect(backupMetadataBytes(Buffer.alloc(0), value, true)).rejects.toMatchObject({ code: 'passphrase' });
  await expect(
    encryptBackupStream({
      source: Readable.from([]),
      plaintextBytes: 0,
      destination: archive,
      passphrase: value,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'passphrase' });
  expect((await fs.readdir(directory)).filter((name) => name.endsWith('.partial'))).toEqual([]);
});

it.each(['12345678', ' abcdefg', 'existing-long-archive-key'])('round-trips file and metadata with an accepted key', async (key) => {
  const input = await fs.readFile(source);
  await encryptBackup({ source, destination: archive, passphrase: key });
  if (process.platform === 'darwin') {
    // Initialize the fixture's macOS tracking flag before the production input seal is taken.
    execFileSync('/usr/bin/python3', [
      '-c',
      'import os,sys; s=os.lstat(sys.argv[1]); os.chflags(sys.argv[1],s.st_flags|64,follow_symlinks=False)',
      archive,
    ]);
  }
  await decryptBackup({ source: archive, destination: restored, passphrase: key });
  expect(await fs.readFile(restored)).toEqual(input);
  const encrypted = await backupMetadataBytes(input, key, false);
  expect(await backupMetadataBytes(encrypted, key, true)).toEqual(input);
  if (key === '12345678') {
    const streamArchive = path.join(directory, 'stream.orbis');
    const streamOutput = path.join(directory, 'stream-restored');
    await encryptBackupStream({
      source: Readable.from([input]),
      plaintextBytes: input.length,
      destination: streamArchive,
      passphrase: key,
      signal: new AbortController().signal,
    });
    if (process.platform === 'darwin')
      execFileSync('/usr/bin/python3', [
        '-c',
        'import os,sys; s=os.lstat(sys.argv[1]); os.chflags(sys.argv[1],s.st_flags|64,follow_symlinks=False)',
        streamArchive,
      ]);
    await decryptBackup({ source: streamArchive, destination: streamOutput, passphrase: key });
    expect(await fs.readFile(streamOutput)).toEqual(input);
  }
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

it('encrypts declared streams using the existing authenticated format and checks exact byte counts', async () => {
  const bytes = Buffer.from('retained ordered runtime frames');
  const result = await encryptBackupStream({
    source: Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]),
    plaintextBytes: bytes.length,
    destination: archive,
    passphrase,
    signal: new AbortController().signal,
  });
  expect(result.bytes).toBe(bytes.length + 52);
  expect(result.sha256).toBe(
    createHash('sha256')
      .update(await fs.readFile(archive))
      .digest('hex'),
  );
  await decryptBackup({ source: archive, destination: restored, passphrase });
  expect(await fs.readFile(restored)).toEqual(bytes);
});
it.each([2, 4])('rejects a stream whose declared length %i differs from its actual bytes', async (plaintextBytes) => {
  const stream = Readable.from([Buffer.from('abc')]);
  await expect(
    encryptBackupStream({ source: stream, plaintextBytes, destination: archive, passphrase, signal: new AbortController().signal }),
  ).rejects.toMatchObject({ code: 'operation-failed' });
  expect(stream.destroyed).toBe(true);
  expect((await fs.readdir(directory)).filter((name) => name.endsWith('.partial'))).toEqual([]);
  await expect(fs.stat(archive)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects the GCM bound before reading or allocating the declared payload', async () => {
  const stream = new Readable({
    read() {
      throw new Error('Must not read');
    },
  });
  await expect(
    encryptBackupStream({
      source: stream,
      plaintextBytes: backupGcmPlaintextLimit + 1,
      destination: archive,
      passphrase,
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ code: 'operation-failed' });
  expect(stream.destroyed).toBe(true);
});
it('cancels an idle runtime stream and closes its private incomplete output', async () => {
  const stream = new Readable({ read() {} });
  const abort = new AbortController();
  const pending = encryptBackupStream({ source: stream, plaintextBytes: 1, destination: archive, passphrase, signal: abort.signal });
  setTimeout(() => abort.abort(), 50);
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  expect(stream.destroyed).toBe(true);
  await expect(fs.stat(archive)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cancels before a stream consumer exists without emitting an unhandled source error', async () => {
  const stream = new Readable({ read() {} });
  const errors: unknown[] = [];
  stream.on('error', (error) => errors.push(error));
  const abort = new AbortController();
  const pending = encryptBackupStream({ source: stream, plaintextBytes: 1, destination: archive, passphrase, signal: abort.signal });
  abort.abort();
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  await new Promise((resolve) => setImmediate(resolve));
  expect(errors).toEqual([]);
  expect(stream.destroyed).toBe(true);
  await expect(fs.stat(archive)).rejects.toMatchObject({ code: 'ENOENT' });
});
