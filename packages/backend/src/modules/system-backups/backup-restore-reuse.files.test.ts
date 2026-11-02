import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BackupImportsService } from './backup-imports.service';
import { reuseRestoreArchive } from './backup-restore-reuse';
import { encryptBackup, decryptBackup } from './backup-crypto';
import type { BackupRestoreJournal } from './backup-restore-journal';

let root: string;
let service: BackupImportsService;
let journal: BackupRestoreJournal;
let payload: string;
const bytes = Buffer.concat([Buffer.from('ORBISBK1'), Buffer.alloc(128, 7)]);
const manifest = 'a'.repeat(64);
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-reuse-')));
  const directory = path.join(root, 'backups', 'restores', randomUUID());
  payload = path.join(directory, 'source', 'payload');
  await fs.mkdir(payload, { recursive: true, mode: 0o700 });
  for (const p of [root, path.join(root, 'backups'), path.join(root, 'backups', 'restores'), directory, path.join(directory, 'source'), payload])
    await fs.chmod(p, 0o700);
  await fs.writeFile(path.join(payload, 'backup.orbis'), bytes, { mode: 0o600 });
  await fs.writeFile(path.join(payload, 'job.json'), JSON.stringify({ id: randomUUID(), ownerId: 7, uploadedBytes: bytes.length }), { mode: 0o600 });
  journal = { directory } as BackupRestoreJournal;
  service = new BackupImportsService({ get: () => ({ dataDir: root }) } as never, {} as never, { warn: vi.fn() } as never, {} as never);
});
afterEach(async () => {
  await service.onModuleDestroy();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
it('copies the same journal ciphertext into distinct owner imports without changing or hardlinking its evidence', async () => {
  const before = await fs.stat(path.join(payload, 'backup.orbis'));
  const jobs = [];
  for (let i = 0; i < 2; i++) jobs.push(await service.reuseRestore(journal, 7, manifest, new AbortController().signal));
  expect(jobs[0]?.id).not.toBe(jobs[1]?.id);
  for (const job of jobs) {
    expect(job.status).toBe('uploaded');
    expect(job.uploadedBytes).toBe(bytes.length);
    const file = path.join(root, 'backups', 'imports', job.id, 'backup.orbis');
    expect(hash(await fs.readFile(file))).toBe(hash(bytes));
    expect((await fs.stat(file)).ino).not.toBe(before.ino);
    const metadata = JSON.parse(await fs.readFile(path.join(path.dirname(file), 'job.json'), 'utf8'));
    expect(metadata.expectedManifestSha256).toBe(manifest);
  }
  expect(hash(await fs.readFile(path.join(payload, 'backup.orbis')))).toBe(hash(bytes));
  expect(await fs.stat(path.join(payload, 'backup.orbis'))).toMatchObject({ ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, nlink: 1 });
  expect((await service.list(8)).jobs).toEqual([]);
  expect((await service.list(7)).jobs).toHaveLength(2);
});
it.each(['foreign-owner', 'missing', 'symlink', 'hardlink', 'public-mode', 'truncated', 'wrong-origin', 'parent-symlink'] as const)(
  'rejects unsafe retained archive %s before publishing a copy',
  async (kind) => {
    const file = path.join(payload, 'backup.orbis');
    if (kind === 'foreign-owner')
      await fs.writeFile(path.join(payload, 'job.json'), JSON.stringify({ id: randomUUID(), ownerId: 8, uploadedBytes: bytes.length }));
    if (kind === 'missing') await fs.unlink(file);
    if (kind === 'symlink') {
      await fs.rename(file, path.join(root, 'archive'));
      await fs.symlink(path.join(root, 'archive'), file);
    }
    if (kind === 'hardlink') await fs.link(file, path.join(root, 'linked'));
    if (kind === 'public-mode') await fs.chmod(file, 0o644);
    if (kind === 'truncated') await fs.truncate(file, 12);
    if (kind === 'wrong-origin')
      await fs.writeFile(
        path.join(payload, 'job.json'),
        JSON.stringify({ id: randomUUID(), ownerId: 7, uploadedBytes: bytes.length, origin: 'time-machine' }),
      );
    if (kind === 'parent-symlink') {
      await fs.rename(payload, path.join(root, 'moved'));
      await fs.symlink(path.join(root, 'moved'), payload);
    }
    await expect(service.reuseRestore(journal, 7, manifest, new AbortController().signal)).rejects.toThrow();
    expect((await service.list(7)).jobs.every((job) => job.status !== 'uploaded')).toBe(true);
  },
);
it('rejects an aborted copy without publishing the archive', async () => {
  await expect(service.reuseRestore(journal, 7, manifest, AbortSignal.abort())).rejects.toThrow();
  expect((await service.list(7)).jobs.every((job) => job.status !== 'uploaded')).toBe(true);
});

it('rejects replacement during copying before the new import can become available', async () => {
  await expect(
    reuseRestoreArchive(journal, 7, new AbortController().signal, async (source, _bytes, verify) => {
      await fs.writeFile(path.join(payload, 'backup.orbis'), Buffer.concat([Buffer.from('ORBISBK1'), Buffer.alloc(128, 8)]));
      for await (const _chunk of source) {
        /* Drain the changed ciphertext before verifying its identity. */
      }
      await verify();
    }),
  ).rejects.toThrow('could not be verified');
});
it('copies actual encrypted bytes which still decrypt with the original in-memory key', async () => {
  const plain = path.join(root, 'plain');
  const encrypted = path.join(root, 'encrypted');
  const key = 'disposable reuse archive key';
  await fs.writeFile(plain, 'encrypted archive copy fixture');
  await encryptBackup({ source: plain, destination: encrypted, passphrase: key });
  await fs.copyFile(encrypted, path.join(payload, 'backup.orbis'));
  const size = (await fs.stat(encrypted)).size;
  await fs.writeFile(path.join(payload, 'job.json'), JSON.stringify({ id: randomUUID(), ownerId: 7, uploadedBytes: size }));
  const job = await service.reuseRestore(journal, 7, manifest, new AbortController().signal);
  const opened = path.join(root, 'opened');
  await decryptBackup({ source: path.join(root, 'backups', 'imports', job.id, 'backup.orbis'), destination: opened, passphrase: key });
  expect(await fs.readFile(opened, 'utf8')).toBe('encrypted archive copy fixture');
  expect(hash(await fs.readFile(path.join(payload, 'backup.orbis')))).toBe(hash(await fs.readFile(encrypted)));
});
