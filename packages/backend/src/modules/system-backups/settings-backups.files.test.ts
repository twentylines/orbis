import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
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

let root: string;
let restore: () => void;
let service: SettingsBackupsService;
let app: INestApplication | undefined;
const actor = { userId: 7, sessionBinding: 'a'.repeat(64), securityBinding: 'b'.repeat(64) };
const auth = { operatorActionContext: vi.fn(), verifySensitiveAction: vi.fn() };
const source = { write: vi.fn() };
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
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'settings-jobs-')));
  restore = stabilizeDarwinFixtureCreation(() => root);
  vi.resetAllMocks();
  auth.operatorActionContext.mockResolvedValue(actor);
  auth.verifySensitiveAction.mockResolvedValue({ operator: true });
  source.write.mockImplementation(async (options) => {
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
  expect(source.write).not.toHaveBeenCalled();
  await expect(create()).rejects.toThrow();
  accepted.start();
  accepted.start();
  expect((await terminal(accepted.job.id))?.status).toBe('ready');
  expect(source.write).toHaveBeenCalledOnce();
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

it('preserves interrupted artifacts on restart and never replays a queued export', async () => {
  const accepted = await create();
  await fs.writeFile(path.join(directory(accepted.job.id), 'preserved-evidence'), 'keep', { mode: 0o600 });
  await service.onModuleDestroy();
  const reloaded = build();
  expect((await reloaded.list(7)).jobs[0]?.status).toBe('interrupted');
  expect(source.write).not.toHaveBeenCalled();
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
  expect(source.write).not.toHaveBeenCalled();
  source.write.mockImplementation(async ({ signal }) => {
    signal.throwIfAborted();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
  });
  const accepted = await create();
  accepted.start();
  await vi.waitFor(() => expect(source.write).toHaveBeenCalledOnce());
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
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer();
  const url = '/system-backups/settings-bundles';
  await request(server).get(url).expect(401);
  const retention = await request(server).get('/system-backups/settings').set('Authorization', 'operator').expect(200);
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
    .send({ ...credentials, passphrase, selection })
    .expect(202);
  expect(accepted.headers['cache-control']).toBe('no-store');
  const job = await terminal(accepted.body.id);
  expect(job?.status).toBe('ready');
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
    passphrase,
    signal: new AbortController().signal,
  });
  expect(reviewed.summary.contents.map((value) => value.kind)).toEqual(['settings', 'dashboard']);
  await reviewed.dispose();
});
