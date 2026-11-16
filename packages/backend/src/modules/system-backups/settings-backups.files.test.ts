import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { defaultSettingsBackupSelection } from '@runtipi/common/schemas/settings-backup';
import { LoggerService } from '@/core/logger/logger.service';
import { setBackupRecoveryRequired, setResetRecoveryRequired, setRestoreRecoveryRequired } from '@/common/backup-maintenance';
import { AuthGuard } from '../auth/auth.guard';
import { DesktopPreferencesService } from '../desktop-preferences/desktop-preferences.service';
import { DesktopWallpaperService } from '../desktop-preferences/desktop-wallpaper.service';
import { ThemePacksService } from '../theme-packs/theme-packs.service';
import { ThemeSettingsService } from '../theme-settings/theme-settings.service';
import { SettingsBackupsService } from './settings-backups.service';
import { SettingsBackupsController } from './settings-backups.controller';
import { SystemBackupsController } from './system-backups.controller';
import { SystemBackupsService } from './system-backups.service';
import { BackupImportsService } from './backup-imports.service';
import { SettingsBackupSourceService } from './settings-backup-source.service';
import { openSettingsBackupReview } from './settings-backup-review';
import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from './darwin-files.fixture';
import type { ResetJournal } from '../system-reset/reset-contract';

let root: string;
let restore: () => void;
let service: SettingsBackupsService;
let app: INestApplication | undefined;
const actor = { userId: 7, sessionBinding: 'a'.repeat(64), securityBinding: 'b'.repeat(64) };
const auth = { operatorActionContext: vi.fn(), verifySensitiveAction: vi.fn() };
const source = { writeAuthorized: vi.fn(), reconcileCaptureOwnership: vi.fn() };
const config = { get: (key: string) => (key === 'directories' ? { dataDir: root } : key === 'userSettings' ? { timeZone: 'UTC' } : 'fixture') };
const credentials = { password: 'fixture private account proof' };
const passphrase = 'fixture private archive proof';
const req = {} as Request;
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const build = () => new SettingsBackupsService(config as never, auth as never, source as never);
const create = () => service.create(7, req, credentials, defaultSettingsBackupSelection(), passphrase);
const directory = (id: string) => path.join(root, 'backups', 'settings-bundles', id);
const archive = (id: string) => path.join(directory(id), 'archive.orbis-settings');
async function terminal(id: string) {
  await vi.waitFor(async () => expect((await service.list(7)).jobs.find((job) => job.id === id)?.status).not.toMatch(/queued|running/), {
    timeout: 10_000,
  });
  return (await service.list(7)).jobs.find((job) => job.id === id);
}
const reset = (users = [7]): ResetJournal => ({
  version: 1,
  id: randomUUID(),
  controller: 'fixture-controller',
  accounts: 'remove',
  users,
  phase: 'prepared',
  createdAt: Date.now(),
});
async function readyBackup() {
  const accepted = await create();
  accepted.start();
  await terminal(accepted.job.id);
  return accepted.job.id;
}
async function completedReset(journal = reset()) {
  await service.prepareResetOwnership(journal);
  const complete = { ...journal, phase: 'complete' as const };
  await service.completeResetOwnership(complete, async () => true);
  return complete;
}
const custody = (journal: ResetJournal, suffix = '') => path.join(root, 'backups', 'reset-custody', `${journal.id}${suffix}`, 'record.json');
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'settings-jobs-')));
  restore = stabilizeDarwinFixtureCreation(() => root);
  vi.resetAllMocks();
  auth.operatorActionContext.mockResolvedValue(actor);
  auth.verifySensitiveAction.mockResolvedValue({ operator: true });
  source.writeAuthorized.mockImplementation(async (options) => {
    const data = Buffer.from('opaque verified source fixture');
    options.progress({ stage: 'verifying', completedBytes: 0, totalBytes: null });
    await fs.writeFile(options.destination, data, { mode: 0o600, flag: 'wx' });
    return { bytes: data.length, sha256: digest(data) };
  });
  setBackupRecoveryRequired(false);
  setResetRecoveryRequired(false);
  setRestoreRecoveryRequired(false);
  service = build();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await service.onModuleDestroy();
  vi.restoreAllMocks();
  restore();
  await fs.rm(root, { recursive: true, force: true });
});

it('reserves one job, starts once, persists progress and exposes a hash-verified downloadable file without saving credentials', async () => {
  const accepted = await create();
  expect(accepted.job.status).toBe('queued');
  expect(source.writeAuthorized).not.toHaveBeenCalled();
  await expect(create()).rejects.toThrow();
  accepted.start();
  accepted.start();
  expect((await terminal(accepted.job.id))?.status).toBe('ready');
  expect(source.writeAuthorized).toHaveBeenCalledOnce();
  expect(source.writeAuthorized.mock.calls[0]?.[0].passphrase).toBe(passphrase);
  expect(source.writeAuthorized.mock.calls[0]?.[0]).not.toHaveProperty('credentials');
  expect(source.writeAuthorized.mock.calls[0]?.[0]).not.toHaveProperty('request');
  const metadata = await fs.readFile(path.join(directory(accepted.job.id), 'job.json'), 'utf8');
  expect(metadata.includes(credentials.password)).toBe(false);
  expect(metadata.includes(passphrase)).toBe(false);
  const downloaded = await service.download(accepted.job.id, 7, req, credentials);
  const chunks: Buffer[] = [];
  for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe('opaque verified source fixture');
  const reloaded = build();
  expect((await reloaded.list(7)).jobs[0]?.status).toBe('ready');
  await reloaded.onModuleDestroy();
});

it('keeps owner isolation and fresh authentication ahead of downloads and deletion', async () => {
  const accepted = await create();
  accepted.start();
  await terminal(accepted.job.id);
  expect((await service.list(8)).jobs).toEqual([]);
  await expect(service.download(accepted.job.id, 8, req, credentials)).rejects.toThrow('not found');
  await expect(service.remove(accepted.job.id, 8, req, credentials)).rejects.toThrow('not found');
  auth.verifySensitiveAction.mockRejectedValueOnce(new Error('Wrong password'));
  await expect(service.download(accepted.job.id, 7, req, credentials)).rejects.toThrow('Wrong password');
  expect(await fs.readFile(archive(accepted.job.id), 'utf8')).toBe('opaque verified source fixture');
});

it('requires an unchanged live owner session for session download admission', async () => {
  const accepted = await create();
  accepted.start();
  await terminal(accepted.job.id);
  await expect(service.downloadInfo(accepted.job.id, 8, req)).rejects.toThrow();
  auth.operatorActionContext.mockRejectedValueOnce(new Error('Session revoked'));
  await expect(service.downloadSession(accepted.job.id, 7, req)).rejects.toThrow('Session revoked');
  auth.operatorActionContext.mockResolvedValueOnce(actor).mockResolvedValueOnce({ ...actor, securityBinding: 'c'.repeat(64) });
  await expect(service.downloadSession(accepted.job.id, 7, req)).rejects.toThrow();
  expect(auth.verifySensitiveAction).toHaveBeenCalledTimes(1);
});

it('uses a verified account password by default and rejects short defaults', async () => {
  await expect(service.create(7, req, { password: 'short' }, defaultSettingsBackupSelection())).rejects.toThrow('separate backup passphrase');
  const accepted = await service.create(7, req, credentials, defaultSettingsBackupSelection());
  accepted.start();
  await terminal(accepted.job.id);
  expect(source.writeAuthorized.mock.calls[0]?.[0].passphrase).toBe(credentials.password);
  const metadata = await fs.readFile(path.join(directory(accepted.job.id), 'job.json'), 'utf8');
  expect(metadata).not.toContain(credentials.password);
});

it('preserves interrupted artifacts on restart and never replays a queued export', async () => {
  const accepted = await create();
  await fs.writeFile(path.join(directory(accepted.job.id), 'preserved-evidence'), 'keep', { mode: 0o600 });
  await service.onModuleDestroy();
  const reloaded = build();
  expect((await reloaded.list(7)).jobs[0]?.status).toBe('interrupted');
  expect(source.writeAuthorized).not.toHaveBeenCalled();
  await expect(reloaded.download(accepted.job.id, 7, req, credentials)).rejects.toThrow();
  expect(await fs.readFile(path.join(directory(accepted.job.id), 'preserved-evidence'), 'utf8')).toBe('keep');
  await reloaded.onModuleDestroy();
});

it('rejects linked or corrupt ready archives and prevents deletion during an admitted download', async () => {
  const accepted = await create();
  accepted.start();
  await terminal(accepted.job.id);
  const downloaded = await service.download(accepted.job.id, 7, req, credentials);
  await expect(service.remove(accepted.job.id, 7, req, credentials)).rejects.toThrow('download');
  downloaded.stream.destroy();
  await new Promise<void>((resolve) => downloaded.stream.once('close', resolve));
  const original = await fs.readFile(archive(accepted.job.id));
  await fs.writeFile(archive(accepted.job.id), Buffer.alloc(original.length), { mode: 0o600 });
  stabilizeExistingDarwinFixtures(root);
  await expect(service.download(accepted.job.id, 7, req, credentials)).rejects.toThrow();
  await fs.unlink(archive(accepted.job.id));
  const elsewhere = path.join(root, 'elsewhere');
  await fs.writeFile(elsewhere, original, { mode: 0o600 });
  await fs.symlink(elsewhere, archive(accepted.job.id));
  await expect(service.download(accepted.job.id, 7, req, credentials)).rejects.toThrow();
  expect(await fs.readFile(elsewhere)).toEqual(original);
});

it('waits for cancellation before releasing the job and cannot start a removed reservation', async () => {
  const queued = await create();
  await service.remove(queued.job.id, 7, req, credentials);
  queued.start();
  expect(source.writeAuthorized).not.toHaveBeenCalled();
  source.writeAuthorized.mockImplementation(async ({ signal }) => {
    signal.throwIfAborted();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
  });
  const accepted = await create();
  accepted.start();
  await vi.waitFor(() => expect(source.writeAuthorized).toHaveBeenCalledOnce());
  await service.onModuleDestroy();
  expect((await service.list(7)).jobs[0]?.status).toBe('cancelled');
  await expect(service.download(accepted.job.id, 7, req, credentials)).rejects.toThrow();
});

it('serves a real selected settings archive through guarded HTTP creation, progress and download routes', async () => {
  const desktop = new DesktopPreferencesService(config as never);
  const wallpaper = new DesktopWallpaperService(config as never, desktop);
  const packs = new ThemePacksService(config as never);
  const themes = new ThemeSettingsService(config as never, packs, desktop);
  const realSource = new SettingsBackupSourceService(config as never, auth as never, desktop, wallpaper, packs, themes, {} as never, {} as never);
  service = new SettingsBackupsService(config as never, auth as never, realSource);
  const module = await Test.createTestingModule({
    controllers: [SystemBackupsController, SettingsBackupsController],
    providers: [
      AuthGuard,
      { provide: SettingsBackupsService, useValue: service },
      { provide: SystemBackupsService, useValue: { settings: () => ({ available: true, retentionHours: 72, revision: 3 }) } },
      { provide: BackupImportsService, useValue: {} },
      { provide: LoggerService, useValue: { debug: vi.fn() } },
    ],
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.use((req: Request, _res: unknown, next: () => void) => {
    if (req.headers.authorization === 'operator') {
      req.user = { id: 7, operator: true } as Request['user'];
      req.authMethod = 'session';
    }
    next();
  });
  app.setGlobalPrefix('/api');
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer();
  const url = '/api/system-backups/settings-bundles';
  await request(server).get(url).expect(401);
  const retention = await request(server).get('/api/system-backups/settings').set('Authorization', 'operator').expect(200);
  expect(retention.body).toEqual({ available: true, retentionHours: 72, revision: 3 });
  const listed = await request(server).get(url).set('Authorization', 'operator').expect(200);
  expect(listed.body).toEqual({ version: 1, jobs: [] });
  const selection = { version: 1, settings: true, dashboard: true, wallpapers: false, themes: false, timeMachine: [] };
  await request(server)
    .post(url)
    .set('Authorization', 'operator')
    .send({ ...credentials, passphrase, selection })
    .expect(403);
  const accepted = await request(server)
    .post(url)
    .set('Authorization', 'operator')
    .set('Host', 'orbis.test')
    .set('Origin', 'http://orbis.test')
    .send({ ...credentials, selection })
    .expect(202);
  expect(accepted.headers['cache-control']).toBe('no-store');
  const job = await terminal(accepted.body.id);
  expect(job?.status).toBe('ready');
  expect(auth.verifySensitiveAction).toHaveBeenCalledOnce();
  const info = await request(server).get(`${url}/${accepted.body.id}/download-info`).set('Authorization', 'operator').expect(200);
  expect(info.headers['cache-control']).toBe('no-store');
  expect(info.body).toEqual({
    version: 1,
    href: `${url}/${accepted.body.id}/download`,
    filename: `orbis-settings-${accepted.body.id}.orbis-settings`,
    bytes: job?.bytes,
    sha256: job?.sha256,
  });
  const sessionDownload = await request(server).get(info.body.href).set('Authorization', 'operator').expect(200);
  expect(sessionDownload.headers['x-content-type-options']).toBe('nosniff');
  expect(sessionDownload.headers['content-length']).toBe(String(job?.bytes));
  expect(digest(sessionDownload.body)).toBe(job?.sha256);
  await request(server).get(info.body.href).expect(401);
  const downloaded = await request(server)
    .post(`${url}/${accepted.body.id}/download`)
    .set('Authorization', 'operator')
    .set('Host', 'orbis.test')
    .set('Origin', 'http://orbis.test')
    .send(credentials)
    .expect(200);
  expect(downloaded.headers['content-disposition']).toContain('.orbis-settings');
  expect(downloaded.headers['content-length']).toBe(String(job?.bytes));
  expect(Buffer.isBuffer(downloaded.body)).toBe(true);
  expect(digest(downloaded.body)).toBe(job?.sha256);
  const file = path.join(root, 'downloaded.orbis-settings');
  await fs.writeFile(file, downloaded.body, { mode: 0o600 });
  stabilizeExistingDarwinFixtures(root);
  const reviewed = await openSettingsBackupReview({
    source: file,
    directory: path.join(root, 'review'),
    passphrase: credentials.password,
    signal: new AbortController().signal,
  });
  expect(reviewed.summary.contents.map((value) => value.kind)).toEqual(['settings', 'dashboard']);
  await reviewed.dispose();
});

it('preparing reset custody preserves original ownership and requires a real completed receipt before availability', async () => {
  const id = await readyBackup();
  const original = await fs.readFile(path.join(directory(id), 'job.json'));
  const journal = reset();
  await service.prepareResetOwnership(journal);
  expect((await service.list(7)).jobs.map((job) => job.id)).toEqual([id]);
  auth.operatorActionContext.mockResolvedValue({ ...actor, userId: 8 });
  expect((await service.list(8, req)).jobs).toEqual([]);
  await expect(service.completeResetOwnership(journal, async () => true)).rejects.toThrow();
  await expect(service.completeResetOwnership({ ...journal, phase: 'complete' }, async () => false)).rejects.toThrow();
  await expect(
    service.completeResetOwnership({ ...journal, phase: 'complete' }, async () => {
      throw new Error('Receipt unavailable');
    }),
  ).rejects.toThrow('Receipt unavailable');
  expect((await service.list(7)).jobs.map((job) => job.id)).toEqual([id]);
  expect((await service.list(8, req)).jobs).toEqual([]);
  expect(await fs.readFile(path.join(directory(id), 'job.json'))).toEqual(original);
  const legacy = { ...reset(), phase: 'complete' as const };
  const receipt = vi.fn(async () => true);
  await service.completeResetOwnership(legacy, receipt);
  expect(receipt).not.toHaveBeenCalled();
  await expect(fs.lstat(custody(legacy))).rejects.toHaveProperty('code', 'ENOENT');
});

it('claims an unchanged ready archive for a new authenticated operator and preserves its legacy job schema and archive bytes', async () => {
  const id = await readyBackup();
  const original = JSON.parse(await fs.readFile(path.join(directory(id), 'job.json'), 'utf8'));
  const bytes = await fs.readFile(archive(id));
  await completedReset();
  expect((await service.list(7)).jobs).toEqual([]);
  expect((await service.list(8)).jobs).toEqual([]);
  await expect(service.downloadInfo(id, 7, req)).rejects.toThrow('not found');
  auth.operatorActionContext.mockResolvedValue({ ...actor, userId: 8 });
  const info = await service.downloadInfo(id, 8, req);
  expect(info.sha256).toBe(original.sha256);
  expect((await service.list(8)).jobs.map((job) => job.id)).toEqual([id]);
  expect((await service.list(7)).jobs).toEqual([]);
  expect(JSON.parse(await fs.readFile(path.join(directory(id), 'job.json'), 'utf8'))).toEqual({ ...original, ownerId: 8 });
  expect(await fs.readFile(archive(id))).toEqual(bytes);
  const download = await service.downloadSession(id, 8, req);
  const chunks: Buffer[] = [];
  for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(bytes);
  expect(auth.verifySensitiveAction).toHaveBeenCalledTimes(1);
  const reloaded = build();
  expect((await reloaded.list(8)).jobs.map((job) => job.id)).toEqual([id]);
  await reloaded.onModuleDestroy();
});

it('denies every removed numeric account id, including an id reused for a fresh operator', async () => {
  const id = await readyBackup();
  const journal = await completedReset(reset([7, 8]));
  for (const userId of journal.users) {
    auth.operatorActionContext.mockResolvedValue({ ...actor, userId });
    expect((await service.list(userId, req)).jobs).toEqual([]);
    await expect(service.downloadInfo(id, userId, req)).rejects.toThrow('not found');
    await expect(service.remove(id, userId, req, credentials)).rejects.toThrow('not found');
  }
  await expect(fs.lstat(custody(journal, '.claim'))).rejects.toHaveProperty('code', 'ENOENT');
  auth.operatorActionContext.mockResolvedValue({ ...actor, userId: 9 });
  expect((await service.list(9, req)).jobs.map((job) => job.id)).toEqual([id]);
});

it.each(['sessionBinding', 'securityBinding', 'userId'] as const)(
  'keeps a failed claim reserved and quarantined when the authenticated %s changes before the metadata rename',
  async (field) => {
    const id = await readyBackup();
    const original = await fs.readFile(path.join(directory(id), 'job.json'));
    const journal = await completedReset();
    const claimant = { ...actor, userId: 8 };
    let calls = 0;
    auth.operatorActionContext.mockImplementation(async () => {
      calls++;
      return calls === 4 ? { ...claimant, [field]: field === 'userId' ? 9 : 'c'.repeat(64) } : claimant;
    });
    await expect(service.list(8, req)).rejects.toThrow();
    expect(calls).toBe(4);
    expect(await fs.readFile(path.join(directory(id), 'job.json'))).toEqual(original);
    expect(JSON.parse(await fs.readFile(custody(journal, '.claim'), 'utf8')).claimantId).toBe(8);
    await expect(fs.lstat(custody(journal, '.claimed'))).rejects.toHaveProperty('code', 'ENOENT');
    expect((await service.list(7)).jobs).toEqual([]);
    expect((await service.list(8)).jobs).toEqual([]);
    auth.operatorActionContext.mockResolvedValue({ ...actor, userId: 9 });
    await expect(service.list(9, req)).rejects.toThrow();
    auth.operatorActionContext.mockResolvedValue(claimant);
    expect((await service.list(8, req)).jobs.map((job) => job.id)).toEqual([id]);
  },
);

it('resumes an interrupted partial metadata transfer only for the recorded new operator after reload', async () => {
  const ids: [string, string] = [await readyBackup(), await readyBackup()];
  ids.sort();
  const originals = await Promise.all(ids.map(async (id) => JSON.parse(await fs.readFile(path.join(directory(id), 'job.json'), 'utf8'))));
  const journal = await completedReset();
  const rename = fs.rename.bind(fs);
  const interrupted = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === path.join(directory(ids[1]), 'job.json')) throw new Error('Interrupted metadata transfer');
    await rename(from, to);
  });
  auth.operatorActionContext.mockResolvedValue({ ...actor, userId: 8 });
  await expect(service.list(8, req)).rejects.toThrow('Interrupted metadata transfer');
  interrupted.mockRestore();
  expect(JSON.parse(await fs.readFile(path.join(directory(ids[0]), 'job.json'), 'utf8')).ownerId).toBe(8);
  expect(JSON.parse(await fs.readFile(path.join(directory(ids[1]), 'job.json'), 'utf8')).ownerId).toBe(7);
  expect((await service.list(7)).jobs).toEqual([]);
  expect((await service.list(8)).jobs).toEqual([]);
  await service.onModuleDestroy();
  service = build();
  auth.operatorActionContext.mockResolvedValue({ ...actor, userId: 9 });
  await expect(service.list(9, req)).rejects.toThrow();
  auth.operatorActionContext.mockResolvedValue({ ...actor, userId: 8 });
  expect((await service.list(8, req)).jobs.map((job) => job.id).sort()).toEqual(ids);
  for (const [index, id] of ids.entries())
    expect(JSON.parse(await fs.readFile(path.join(directory(id), 'job.json'), 'utf8'))).toEqual({ ...originals[index], ownerId: 8 });
  expect(JSON.parse(await fs.readFile(custody(journal, '.claimed'), 'utf8')).claimantId).toBe(8);
});

it('rejects custody preparation while an export is reserved, running or closing', async () => {
  const journal = reset();
  const accepted = await create();
  await expect(service.prepareResetOwnership(journal)).rejects.toThrow();
  source.writeAuthorized.mockImplementation(async ({ signal }) => {
    signal.throwIfAborted();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
  });
  accepted.start();
  await vi.waitFor(() => expect(source.writeAuthorized).toHaveBeenCalledOnce());
  await expect(service.prepareResetOwnership(journal)).rejects.toThrow();
  await service.onModuleDestroy();
  await expect(service.prepareResetOwnership(journal)).rejects.toThrow();
  await expect(fs.lstat(custody(journal))).rejects.toHaveProperty('code', 'ENOENT');
});

it('uses the shared mutation admission and does not claim during reset maintenance', async () => {
  const id = await readyBackup();
  const journal = await completedReset();
  auth.operatorActionContext.mockResolvedValue({ ...actor, userId: 8 });
  setResetRecoveryRequired(true);
  await expect(service.list(8, req)).rejects.toThrow();
  await expect(fs.lstat(custody(journal, '.claim'))).rejects.toHaveProperty('code', 'ENOENT');
  setResetRecoveryRequired(false);
  expect((await service.list(8, req)).jobs.map((job) => job.id)).toEqual([id]);
});

it('allows a missing saved job without blocking remaining archives and assigns a fresh cohort on a later reset', async () => {
  const removed = await readyBackup();
  const kept = await readyBackup();
  await completedReset();
  await fs.rm(directory(removed), { recursive: true });
  auth.operatorActionContext.mockResolvedValue({ ...actor, userId: 8 });
  expect((await service.list(8, req)).jobs.map((job) => job.id)).toEqual([kept]);
  const second = reset([8]);
  await completedReset(second);
  expect((await service.list(8, req)).jobs).toEqual([]);
  auth.operatorActionContext.mockResolvedValue({ ...actor, userId: 9 });
  expect((await service.list(9, req)).jobs.map((job) => job.id)).toEqual([kept]);
});

it('keeps metadata changed after preparation quarantined instead of transferring unverified content', async () => {
  const id = await readyBackup();
  await completedReset();
  const filename = path.join(directory(id), 'job.json');
  const changed = JSON.parse(await fs.readFile(filename, 'utf8'));
  changed.createdAt++;
  await fs.writeFile(filename, JSON.stringify(changed), { mode: 0o600 });
  stabilizeExistingDarwinFixtures(root);
  auth.operatorActionContext.mockResolvedValue({ ...actor, userId: 8 });
  await expect(service.list(8, req)).rejects.toThrow();
  expect(JSON.parse(await fs.readFile(filename, 'utf8'))).toEqual(changed);
  expect((await service.list(7)).jobs).toEqual([]);
});

it('reconciles a partial prior claim before a second reset captures the new operator cohort', async () => {
  const ids: [string, string] = [await readyBackup(), await readyBackup()];
  ids.sort();
  await completedReset();
  const rename = fs.rename.bind(fs);
  const interrupted = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === path.join(directory(ids[1]), 'job.json')) throw new Error('Interrupted metadata transfer');
    await rename(from, to);
  });
  auth.operatorActionContext.mockResolvedValue({ ...actor, userId: 8 });
  await expect(service.list(8, req)).rejects.toThrow('Interrupted metadata transfer');
  interrupted.mockRestore();
  await service.reconcileResetOwnership(8, req);
  await completedReset(reset([8]));
  expect((await service.list(8)).jobs).toEqual([]);
  auth.operatorActionContext.mockResolvedValue({ ...actor, userId: 9 });
  expect((await service.list(9, req)).jobs.map((job) => job.id).sort()).toEqual(ids);
});

it('refreshes in-memory ownership when an interrupted metadata rename committed before reporting failure', async () => {
  const id = await readyBackup();
  await completedReset();
  const rename = fs.rename.bind(fs);
  const interrupted = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    await rename(from, to);
    if (to === path.join(directory(id), 'job.json')) throw new Error('Interrupted after committed rename');
  });
  auth.operatorActionContext.mockResolvedValue({ ...actor, userId: 8 });
  await expect(service.list(8, req)).rejects.toThrow('Interrupted after committed rename');
  interrupted.mockRestore();
  expect(JSON.parse(await fs.readFile(path.join(directory(id), 'job.json'), 'utf8')).ownerId).toBe(8);
  expect((await service.list(7)).jobs).toEqual([]);
  expect((await service.list(8)).jobs).toEqual([]);
  expect((await service.list(8, req)).jobs.map((job) => job.id)).toEqual([id]);
  expect((await service.list(7)).jobs).toEqual([]);
});

it('cannot create an unrecorded export after reset has closed mutation admission', async () => {
  await service.list(7);
  setResetRecoveryRequired(true);
  try {
    await expect(create()).rejects.toThrow();
    expect(await fs.readdir(path.join(root, 'backups', 'settings-bundles'))).toEqual([]);
    expect(source.writeAuthorized).not.toHaveBeenCalled();
  } finally {
    setResetRecoveryRequired(false);
  }
});
