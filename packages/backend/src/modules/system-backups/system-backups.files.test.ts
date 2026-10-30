import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SystemBackupsService } from './system-backups.service';
import { BackupRequirementError } from './backup-files';
import { backupMaintenanceActive, setBackupRecoveryRequired } from '@/common/backup-maintenance';
import { decryptBackup } from './backup-crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BackupRestoreJournal } from './backup-restore-journal';
import { BackupDirectorySwap } from './backup-directory-swap';
import { acquireRestoreLease } from './backup-restore-lease';

let directory: string;
let service: SystemBackupsService;
const passphrase = 'disposable-full-backup-passphrase';
const credentials = { password: 'disposable-test-password' };
const container = { id: 'a'.repeat(64), project: 'fixture_store', running: true };
const auth = { verifySensitiveAction: vi.fn().mockResolvedValue({ id: 1 }) };
const apps = { getApps: vi.fn().mockResolvedValue([{ appName: 'fixture', appStoreSlug: 'store', status: 'running' }]) };
const tasks = { read: vi.fn().mockResolvedValue({ tasks: [] }) };
const host = { status: vi.fn().mockResolvedValue({ available: false }) };
const runtime = { plan: vi.fn(), stop: vi.fn(), resume: vi.fn(), dumpDatabase: vi.fn() };
const logger = { warn: vi.fn() };
const database = { execute: vi.fn().mockResolvedValue({ rows: [{ bytes: '1024' }] }) };
let config: { get: (key: string) => unknown };
const createService = () =>
  new SystemBackupsService(
    ...([config, auth, apps, tasks, host, runtime, logger, database] as unknown as ConstructorParameters<typeof SystemBackupsService>),
  );

async function terminal(id: string) {
  await vi.waitFor(
    async () => {
      const job = (await service.list(1)).jobs.find((value) => value.id === id);
      expect(job?.status).not.toBe('running');
    },
    { timeout: 10_000 },
  );
  return (await service.list(1)).jobs.find((value) => value.id === id);
}

beforeEach(async () => {
  vi.clearAllMocks();
  setBackupRecoveryRequired(false);
  directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-export-service-')));
  await fs.mkdir(path.join(directory, 'data', 'state'), { recursive: true });
  await fs.mkdir(path.join(directory, 'app-data'), { mode: 0o700 });
  await fs.writeFile(path.join(directory, 'data', '.env'), 'DISPOSABLE_FIXTURE=true');
  await fs.writeFile(path.join(directory, 'data', 'state', 'seed'), 'disposable recovery fixture');
  await fs.writeFile(path.join(directory, 'app-data', 'content'), 'actual fixture app data');
  config = {
    get: (key) =>
      ({
        directories: { dataDir: path.join(directory, 'data'), appDataDir: path.join(directory, 'app-data') },
        envFilePath: path.join(directory, 'data', '.env'),
        userSettings: { timeZone: 'UTC' },
        version: '4.10.1',
        architecture: 'arm64',
        jwtSecret: 'disposable fixture only',
      })[key],
  };
  runtime.plan.mockResolvedValue({ databaseId: 'b'.repeat(64), containers: [container], images: [] });
  runtime.stop.mockResolvedValue(undefined);
  runtime.resume.mockResolvedValue(undefined);
  runtime.dumpDatabase.mockImplementation(async (_id, file, signal, progress) => {
    signal.throwIfAborted();
    await fs.writeFile(file, 'PGDMPdisposable database fixture', { mode: 0o600 });
    progress(30);
  });
  auth.verifySensitiveAction.mockResolvedValue({ id: 1 });
  service = createService();
});
afterEach(async () => {
  await service.onModuleDestroy();
  setBackupRecoveryRequired(false);
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

it('creates one encrypted export containing configuration, database and app data, and removes plaintext staging', async () => {
  const started = await service.start(1, credentials, passphrase);
  const job = await terminal(started.id);
  expect(job?.status).toBe('succeeded');
  expect(runtime.stop).toHaveBeenCalledWith(container);
  expect(runtime.resume).toHaveBeenCalledWith([container]);
  const stored = path.join(directory, 'data', 'backups', 'full', started.id);
  expect((await fs.readdir(stored)).sort()).toEqual(['backup.orbis', 'job.json']);
  const metadata = await fs.readFile(path.join(stored, 'job.json'), 'utf8');
  expect(metadata).not.toContain(passphrase);
  expect(metadata).not.toContain(credentials.password);
  const archive = path.join(directory, 'opened.tar.gz');
  await decryptBackup({ source: path.join(stored, 'backup.orbis'), destination: archive, passphrase });
  const restored = path.join(directory, 'restored');
  await fs.mkdir(restored);
  await promisify(execFile)('tar', ['-xzf', archive, '-C', restored]);
  expect(await fs.readFile(path.join(restored, 'app-data', 'content'), 'utf8')).toBe('actual fixture app data');
  expect(await fs.readFile(path.join(restored, 'data', 'state', 'seed'), 'utf8')).toBe('disposable recovery fixture');
  expect(await fs.readFile(path.join(restored, 'database.dump'), 'utf8')).toMatch(/^PGDMP/);
  expect(JSON.parse(await fs.readFile(path.join(restored, 'manifest.json'), 'utf8')).format).toBe('orbis-full-backup');
  expect(backupMaintenanceActive()).toBe(false);
  expect((await service.list(2)).jobs).toEqual([]);
  await expect(service.download(started.id, 2, credentials)).rejects.toThrow('not found');
});

it('requires successful reauthentication before writing any backup job', async () => {
  auth.verifySensitiveAction.mockRejectedValueOnce(new Error('Invalid credentials'));
  await expect(service.start(1, credentials, passphrase)).rejects.toThrow('Invalid credentials');
  expect(runtime.plan).not.toHaveBeenCalled();
  expect(await fs.readdir(path.join(directory, 'data', 'backups', 'full'))).toEqual([]);
});

it('exports current files twice after restore while preserving and omitting only its retained generations', async () => {
  const store = path.join(directory, 'data', 'backups', 'restores');
  const journal = await BackupRestoreJournal.create(store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: '1'.repeat(64),
    candidateController: '2'.repeat(64),
    worker: '3'.repeat(64),
    roots: ['state', 'app-data'],
  });
  const swaps: BackupDirectorySwap[] = [];
  for (const [name, root, file, content] of [
    ['state', path.join(directory, 'data', 'state'), 'seed', 'restored seed'],
    ['app-data', path.join(directory, 'app-data'), 'content', 'restored current app data'],
  ]) {
    const swap = await BackupDirectorySwap.create({ id: journal.state.id, root: root as string, journal: journal.rootJournal(name as string) });
    await fs.writeFile(path.join(swap.incomingDirectory, file as string), content as string, { mode: 0o600 });
    await swap.seal(new AbortController().signal);
    swaps.push(swap);
  }
  await journal.advance('prepared');
  await journal.advance('quiescing');
  await journal.advance('promoting');
  for (const swap of swaps) await swap.promote(new AbortController().signal);
  await journal.advance('verifying');
  await journal.advance('committing');
  for (const swap of swaps) await swap.commit();
  await journal.advance('completed');
  const retained = path.join(directory, 'app-data', `.orbis-restore-${journal.state.id}.previous`, 'content');
  const original = await fs.readFile(retained);
  for (let attempt = 0; attempt < 2; attempt++) {
    const job = await terminal((await service.start(1, credentials, passphrase)).id);
    expect(job?.status).toBe('succeeded');
    if (!job) throw new Error('Missing export job');
    const archive = path.join(directory, `export-${attempt}.tar.gz`);
    await decryptBackup({ source: path.join(directory, 'data', 'backups', 'full', job.id, 'backup.orbis'), destination: archive, passphrase });
    const destination = path.join(directory, `export-${attempt}`);
    await fs.mkdir(destination);
    await promisify(execFile)('tar', ['-xzf', archive, '-C', destination]);
    expect(await fs.readFile(path.join(destination, 'app-data', 'content'), 'utf8')).toBe('restored current app data');
    expect(await fs.readFile(path.join(destination, 'data', 'state', 'seed'), 'utf8')).toBe('restored seed');
    const manifest = JSON.parse(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8'));
    expect(manifest.exclusions).toContain('restore-recovery-files');
    expect(manifest.files.some((file: { name: string }) => file.name.includes('.orbis-restore-'))).toBe(false);
    expect(manifest.directories.some((file: { name: string }) => file.name.includes('.orbis-restore-'))).toBe(false);
    expect(await fs.readFile(retained)).toEqual(original);
  }
  const next = await BackupRestoreJournal.create(store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: '2'.repeat(64),
    candidateController: '4'.repeat(64),
    worker: '5'.repeat(64),
    roots: ['state'],
  });
  expect(next.state.phase).toBe('staging');
  await expect(fs.lstat(retained)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(directory, 'app-data', 'content'), 'utf8')).toBe('restored current app data');
});

it('rejects export before stopping apps when a restore is unfinished or holds the shared lease', async () => {
  const store = path.join(directory, 'data', 'backups', 'restores');
  const release = await acquireRestoreLease(store);
  try {
    const job = await terminal((await service.start(1, credentials, passphrase)).id);
    expect(job?.status).toBe('failed');
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(backupMaintenanceActive()).toBe(false);
  } finally {
    release();
  }
  await BackupRestoreJournal.create(store, {
    id: randomUUID(),
    nonce: randomUUID(),
    originalController: '1'.repeat(64),
    candidateController: '2'.repeat(64),
    worker: '3'.repeat(64),
    roots: ['state'],
  });
  const job = await terminal((await service.start(1, credentials, passphrase)).id);
  expect(job?.status).toBe('failed');
  expect(job?.message).toContain('Finish or discard');
  expect(runtime.stop).not.toHaveBeenCalled();
});

it('holds the restore lease through snapshot work and releases it after cancellation', async () => {
  runtime.dumpDatabase.mockImplementationOnce(async (_id, _file, signal: AbortSignal) => {
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const store = path.join(directory, 'data', 'backups', 'restores');
  const started = await service.start(1, credentials, passphrase);
  await vi.waitFor(async () => expect((await service.list(1)).jobs[0]?.stage).toBe('database'));
  await expect(acquireRestoreLease(store)).rejects.toThrow('database is locked');
  expect((await service.cancel(started.id, 1)).status).toBe('cancelled');
  const release = await acquireRestoreLease(store);
  release();
  expect(backupMaintenanceActive()).toBe(false);
});

it('allows only one simultaneous export and refuses foreign job deletion', async () => {
  const result = await Promise.allSettled([service.start(1, credentials, passphrase), service.start(1, credentials, passphrase)]);
  expect(result.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
  const started = result.find((value) => value.status === 'fulfilled');
  if (started?.status !== 'fulfilled') throw new Error('No export was started');
  await terminal(started.value.id);
  await expect(service.remove(started.value.id, 2)).rejects.toThrow('not found');
});

it('fails before stopping apps when external data cannot be included', async () => {
  runtime.plan.mockRejectedValueOnce(new BackupRequirementError('Review external storage before creating a full backup.'));
  const job = await terminal((await service.start(1, credentials, passphrase)).id);
  expect(job?.status).toBe('failed');
  expect(job?.message).toContain('external storage');
  expect(runtime.stop).not.toHaveBeenCalled();
  expect(backupMaintenanceActive()).toBe(false);
});

it('checks available space before stopping apps', async () => {
  vi.spyOn(fs, 'statfs').mockResolvedValueOnce({ bavail: 0, bsize: 4096 } as Awaited<ReturnType<typeof fs.statfs>>);
  const job = await terminal((await service.start(1, credentials, passphrase)).id);
  expect(job?.message).toContain('not enough free storage');
  expect(runtime.stop).not.toHaveBeenCalled();
});

it('cancels the database stage, restarts apps and leaves no downloadable or plaintext partial export', async () => {
  runtime.dumpDatabase.mockImplementationOnce(async (_id, file, signal: AbortSignal) => {
    await fs.writeFile(file, 'PGDMPpartial', { mode: 0o600 });
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  const started = await service.start(1, credentials, passphrase);
  await vi.waitFor(async () => expect((await service.list(1)).jobs[0]?.stage).toBe('database'));
  const cancelled = await service.cancel(started.id, 1);
  expect(cancelled.status).toBe('cancelled');
  expect(runtime.resume).toHaveBeenCalled();
  expect(await fs.readdir(path.join(directory, 'data', 'backups', 'full', started.id))).toEqual(['job.json']);
  await expect(service.download(started.id, 1, credentials)).rejects.toThrow('not available');
});

it('persists failed app recovery, blocks later mutations and recovers only after reauthentication', async () => {
  runtime.resume.mockRejectedValue(new Error('disposable Docker failure'));
  const started = await service.start(1, credentials, passphrase);
  const job = await terminal(started.id);
  expect(job?.status).toBe('interrupted');
  expect(job?.needsRecovery).toBe(true);
  expect(backupMaintenanceActive()).toBe(true);
  await expect(service.start(1, credentials, passphrase)).rejects.toThrow('recover');
  await service.onModuleDestroy();
  service = createService();
  await service.onModuleInit();
  expect((await service.list(1)).jobs[0]?.needsRecovery).toBe(true);
  runtime.resume.mockResolvedValue(undefined);
  const recovered = await service.recover(started.id, 1, credentials);
  expect(recovered.needsRecovery).toBe(false);
  expect(recovered.restartRequired).toBe(true);
  expect(backupMaintenanceActive()).toBe(true);
  await expect(service.start(1, credentials, passphrase)).rejects.toThrow('recover');
  service = createService();
  await service.onModuleInit();
  expect(backupMaintenanceActive()).toBe(false);
  expect((await service.list(1)).jobs[0]?.restartRequired).toBe(false);
});

it('never returns internal exception details in job status or logs', async () => {
  runtime.dumpDatabase.mockRejectedValueOnce(new Error('disposable-private-driver-value'));
  const job = await terminal((await service.start(1, credentials, passphrase)).id);
  expect(JSON.stringify(job)).not.toContain('disposable-private-driver-value');
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('disposable-private-driver-value');
});

it('preserves unreadable journals and fails closed instead of overwriting them', async () => {
  await service.onModuleInit();
  const bad = path.join(directory, 'data', 'backups', 'full', '11111111-1111-4111-8111-111111111111');
  await fs.mkdir(bad, { mode: 0o700 });
  await fs.writeFile(path.join(bad, 'job.json'), '{broken', { mode: 0o600 });
  service = createService();
  expect((await service.list(1)).available).toBe(false);
  await expect(service.start(1, credentials, passphrase)).rejects.toThrow('storage needs review');
  expect(await fs.readFile(path.join(bad, 'job.json'), 'utf8')).toBe('{broken');
});

it('creates a fresh-auth one-request grant backed by the actual account-password encrypted archive, without storing credentials', async () => {
  const requestId = randomUUID();
  const grant = await service.startTransferExport(1, credentials, credentials.password, requestId, Date.now() + 60_000);
  const summary = await grant.ready;
  expect(grant.requestId).toBe(requestId);
  const opened = await grant.open();
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  const encrypted = Buffer.concat(chunks);
  expect(encrypted.length).toBe(summary.bytes);
  expect(encrypted.subarray(0, 8).toString()).toBe('ORBISBK1');
  expect(auth.verifySensitiveAction).toHaveBeenCalledTimes(1);
  const archive = path.join(directory, 'grant-opened.tar.gz');
  const saved = path.join(directory, 'grant-encrypted.orbis');
  await fs.writeFile(saved, encrypted, { mode: 0o600 });
  await decryptBackup({ source: saved, destination: archive, passphrase: credentials.password });
  expect((await fs.stat(archive)).size).toBeGreaterThan(0);
  await expect(grant.open()).rejects.toThrow('already been claimed');
  const metadata = await fs.readFile(path.join(directory, 'data', 'backups', 'full', grant.backupId, 'job.json'), 'utf8');
  expect(metadata).not.toContain(credentials.password);
  expect(metadata).not.toContain(requestId);
});
it('does not mint a transfer grant or start an export when fresh source authentication fails', async () => {
  auth.verifySensitiveAction.mockRejectedValueOnce(new Error('Denied'));
  await expect(service.startTransferExport(1, credentials, credentials.password, randomUUID(), Date.now() + 60_000)).rejects.toThrow('Denied');
  expect((await service.list(1)).jobs).toEqual([]);
  expect(runtime.stop).not.toHaveBeenCalled();
});
it('expires or revokes a sealed grant without a new public unauthenticated download path', async () => {
  const deadline = Date.now() + 60_000;
  const grant = await service.startTransferExport(1, credentials, passphrase, randomUUID(), deadline);
  await grant.ready;
  vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
  await expect(grant.open()).rejects.toThrow('expired');
  vi.restoreAllMocks();
  await grant.cancel();
  await expect(grant.open()).rejects.toThrow('expired');
  auth.verifySensitiveAction.mockRejectedValueOnce(new Error('Denied'));
  await expect(service.download(grant.backupId, 1, credentials)).rejects.toThrow('Denied');
});
it('refuses changed archive bytes or filesystem identity between grant readiness and opening', async () => {
  const grant = await service.startTransferExport(1, credentials, passphrase, randomUUID(), Date.now() + 60_000);
  await grant.ready;
  await fs.appendFile(path.join(directory, 'data', 'backups', 'full', grant.backupId, 'backup.orbis'), Buffer.from('changed'));
  await expect(grant.open()).rejects.toThrow('changed');
});
it('revokes old in-memory grants during shutdown and never replays them from persisted encrypted-job metadata', async () => {
  const grant = await service.startTransferExport(1, credentials, passphrase, randomUUID(), Date.now() + 60_000);
  await grant.ready;
  await service.onModuleDestroy();
  await expect(grant.open()).rejects.toThrow('expired');
  service = createService();
  expect((await service.list(1)).jobs.some((job) => job.id === grant.backupId)).toBe(true);
  auth.verifySensitiveAction.mockRejectedValueOnce(new Error('Denied'));
  await expect(service.download(grant.backupId, 1, credentials)).rejects.toThrow('Denied');
});
it('a failed export cannot produce a grant stream and preserves normal app recovery', async () => {
  runtime.dumpDatabase.mockRejectedValueOnce(new Error('Failed database export'));
  const grant = await service.startTransferExport(1, credentials, passphrase, randomUUID(), Date.now() + 60_000);
  await expect(grant.ready).rejects.toThrow('not available');
  await expect(grant.open()).rejects.toThrow();
  expect(runtime.resume).toHaveBeenCalledWith([container]);
  expect((await terminal(grant.backupId))?.status).toBe('failed');
});
