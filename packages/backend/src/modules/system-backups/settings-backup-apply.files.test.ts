import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Request } from 'express';
import httpRequest from 'supertest';
import { defaultSettingsBackupSelection } from '@runtipi/common/schemas/settings-backup';
import { ConfigurationService, runtimeUserSettingsSchema } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AuthGuard } from '../auth/auth.guard';
import {
  backupMaintenanceActive,
  setBackupRecoveryRequired,
  setResetRecoveryRequired,
  setRestoreRecoveryRequired,
  setSettingsRestoreRecoveryRequired,
} from '@/common/backup-maintenance';
import { DesktopPreferencesService, DEFAULT_DESKTOP_PREFERENCES } from '../desktop-preferences/desktop-preferences.service';
import { DesktopWallpaperService } from '../desktop-preferences/desktop-wallpaper.service';
import { ThemePacksService } from '../theme-packs/theme-packs.service';
import { ThemeSettingsService } from '../theme-settings/theme-settings.service';
import { SettingsBackupSourceService } from './settings-backup-source.service';
import { SettingsBackupImportsService } from './settings-backup-imports.service';
import { SettingsBackupApplyService } from './settings-backup-apply.service';
import { SettingsBackupTransaction } from './settings-backup-transaction';
import { SettingsBackupImportsController } from './settings-backup-imports.controller';
import { SettingsBackupApplyController } from './settings-backup-apply.controller';
import { stabilizeDarwinFixtureCreation, stabilizeExistingDarwinFixtures } from './darwin-files.fixture';

let root: string;
let restore: () => void;
let config: ConfigurationService;
let desktop: DesktopPreferencesService;
let wallpapers: DesktopWallpaperService;
let themes: ThemeSettingsService;
let source: SettingsBackupSourceService;
let imports: SettingsBackupImportsService;
let apply: SettingsBackupApplyService;
let app: INestApplication | undefined;
const request = {} as never;
const credentials = { password: 'fixture account proof' };
const passphrase = 'fixture archive passphrase';
const actor = { userId: 7, sessionBinding: 'a'.repeat(64), securityBinding: 'b'.repeat(64) };
const auth = { operatorActionContext: async () => actor, verifySensitiveAction: async () => undefined };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const signal = new AbortController().signal;
const build = () => new SettingsBackupApplyService(config, auth as never, imports, desktop, themes, {} as never);
const runtime = () => ({
  advancedSettings: false,
  allowAutoThemes: true,
  allowErrorMonitoring: false,
  appDataPath: '/fixture/apps',
  appsRepoUrl: 'https://example.test/apps',
  demoMode: false,
  dnsIp: '9.9.9.9',
  domain: '',
  eventsTimeout: 5,
  forwardAuthUrl: 'http://orbis.test',
  guestDashboard: false,
  internalIp: '127.0.0.1',
  listenIp: '127.0.0.1',
  localDomain: 'orbis.local',
  logLevel: 'info',
  maxBackups: 0,
  persistTraefikConfig: false,
  port: 80,
  postgresPort: 5432,
  sslPort: 443,
  timeZone: 'UTC',
  themeBase: 'light',
  themeColor: 'blue',
  experimental: { insecureCookie: false },
});
beforeEach(async () => {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required');
  root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'settings-apply-')));
  restore = stabilizeDarwinFixtureCreation(() => root);
  for (const directory of ['state', 'exports']) await fs.mkdir(path.join(root, directory), { mode: 0o700 });
  await fs.writeFile(path.join(root, 'state/settings.json'), JSON.stringify({ timeZone: 'UTC', guestDashboard: false }), { mode: 0o600 });
  config = Object.assign(Object.create(ConfigurationService.prototype), {
    config: { directories: { dataDir: root }, userSettings: runtimeUserSettingsSchema.assert(runtime()), version: 'fixture', architecture: 'amd64' },
    initSentry: vi.fn().mockResolvedValue(undefined),
  });
  desktop = new DesktopPreferencesService(config);
  wallpapers = new DesktopWallpaperService(config, desktop);
  const packs = new ThemePacksService(config);
  themes = new ThemeSettingsService(config, packs, desktop);
  source = new SettingsBackupSourceService(config, auth as never, desktop, wallpapers, packs, themes, {} as never, {} as never);
  imports = new SettingsBackupImportsService(config, auth as never, source);
  apply = build();
  setBackupRecoveryRequired(false);
  setResetRecoveryRequired(false);
  setRestoreRecoveryRequired(false);
  setSettingsRestoreRecoveryRequired(false);
  stabilizeExistingDarwinFixtures(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
  await apply.onModuleDestroy();
  await imports.onModuleDestroy();
  setSettingsRestoreRecoveryRequired(false);
  expect(backupMaintenanceActive()).toBe(false);
  restore();
  await fs.rm(root, { recursive: true, force: true });
});

it('uploads, reviews and selectively restores through real guarded HTTP routes', async () => {
  await desktop.write(7, {
    ...DEFAULT_DESKTOP_PREFERENCES,
    workspace: { ...DEFAULT_DESKTOP_PREFERENCES.workspace, pinnedApps: ['jellyfin:fixture'] },
  });
  await backup();
  await desktop.write(7, { ...DEFAULT_DESKTOP_PREFERENCES, serverName: 'Keep current name', preset: 'ocean' });
  const module = await Test.createTestingModule({
    controllers: [SettingsBackupImportsController, SettingsBackupApplyController],
    providers: [
      AuthGuard,
      { provide: LoggerService, useValue: { debug: vi.fn() } },
      { provide: SettingsBackupImportsService, useValue: imports },
      { provide: SettingsBackupApplyService, useValue: apply },
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
  const base = '/system-backups/settings-bundles';
  const post = (url: string) =>
    httpRequest(server).post(url).set('Authorization', 'operator').set('Host', 'orbis.test').set('Origin', 'http://orbis.test');
  await httpRequest(server).get(`${base}/imports`).expect(401);
  await httpRequest(server).post(`${base}/imports`).set('Authorization', 'operator').send(credentials).expect(403);
  const created = await post(`${base}/imports`).send(credentials).expect(201);
  const bytes = await fs.readFile(path.join(root, 'exports/saved.orbis-settings'));
  await httpRequest(server)
    .put(`${base}/imports/${created.body.id}/file`)
    .set('Authorization', 'operator')
    .set('Host', 'orbis.test')
    .set('Origin', 'http://orbis.test')
    .set('Content-Type', 'application/octet-stream')
    .send(bytes)
    .expect(200);
  await post(`${base}/imports/${created.body.id}/review`)
    .send({ ...credentials, passphrase })
    .expect(202);
  await vi.waitFor(async () => expect((await imports.list(7)).jobs.find((job) => job.id === created.body.id)?.status).toBe('reviewed'), {
    timeout: 10_000,
  });
  const listed = await httpRequest(server).get(`${base}/imports`).set('Authorization', 'operator').expect(200);
  const inspected = listed.body.jobs[0].review;
  expect(inspected.contents.map((item: { kind: string }) => item.kind)).toEqual(['settings', 'dashboard', 'wallpapers', 'themes']);
  const selection = {
    version: 1,
    reviewId: inspected.reviewId,
    archiveSha256: inspected.archiveSha256,
    contents: { version: 1, settings: false, dashboard: true, wallpapers: false, themes: false, timeMachine: [] },
  };
  const accepted = await post(`${base}/imports/${created.body.id}/restore`)
    .send({ ...credentials, passphrase, selection })
    .expect(202);
  expect(accepted.headers['cache-control']).toBe('no-store');
  expect((await terminal(accepted.body.id))?.status).toBe('succeeded');
  expect(await desktop.read(7)).toMatchObject({ serverName: 'Keep current name', preset: 'ocean', workspace: { pinnedApps: ['jellyfin:fixture'] } });
  const status = await httpRequest(server).get(`${base}/restores`).set('Authorization', 'operator').expect(200);
  expect(status.body.job.status).toBe('succeeded');
  await post(`${base}/imports/${created.body.id}/restore`)
    .send({ ...credentials, passphrase, selection })
    .expect(409);
});
async function backup() {
  await source.write({
    ownerId: 7,
    request,
    credentials,
    selection: defaultSettingsBackupSelection(),
    passphrase,
    directory: path.join(root, 'exports'),
    destination: path.join(root, 'exports/saved.orbis-settings'),
    signal,
  });
}
async function review() {
  const bytes = await fs.readFile(path.join(root, 'exports/saved.orbis-settings'));
  const job = await imports.create(7, request, credentials);
  await imports.upload(job.id, 7, Readable.from([bytes]), String(bytes.length), signal);
  const accepted = await imports.review(job.id, 7, request, credentials, passphrase);
  await accepted.start;
  const verified = (await imports.list(7)).jobs.find((value) => value.id === job.id)?.review;
  if (!verified) throw new Error('Expected an actually verified backup');
  return {
    importId: job.id,
    selection: { version: 1, reviewId: verified.reviewId, archiveSha256: verified.archiveSha256, contents: verified.available },
  };
}
async function terminal(id: string) {
  await vi.waitFor(
    async () => {
      expect(['succeeded', 'rolled-back', 'recovery-required']).toContain((await apply.status(7)).job?.status);
    },
    { timeout: 30_000 },
  );
  const result = (await apply.status(7)).job;
  expect(result?.id).toBe(id);
  return result;
}

it('keeps current settings when the operator is revoked during restore preparation', async () => {
  await backup();
  const checked = await review();
  const before = await fs.readFile(path.join(root, 'state/settings.json'));
  const saved = await fs.readFile(path.join(root, 'exports/saved.orbis-settings'));
  const original = SettingsBackupTransaction.prepare;
  const prepared = vi.spyOn(SettingsBackupTransaction, 'prepare').mockImplementation(async (options) => {
    const transaction = await original(options);
    vi.spyOn(auth, 'operatorActionContext').mockRejectedValue(new Error('Operator session revoked.'));
    return transaction;
  });
  const promote = vi.spyOn(SettingsBackupTransaction.prototype, 'applyFiles');
  try {
    const accepted = await apply.accept(checked.importId, 7, request, credentials, checked.selection, passphrase);
    accepted.start();
    expect((await terminal(accepted.job.id))?.status).toBe('rolled-back');
    expect(prepared).toHaveBeenCalledOnce();
    expect(promote).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, 'state/settings.json'))).toEqual(before);
    expect(await fs.readFile(path.join(root, 'exports/saved.orbis-settings'))).toEqual(saved);
    expect(backupMaintenanceActive()).toBe(false);
  } finally {
    vi.restoreAllMocks();
  }
});

it('restores selected real settings, pins, wallpaper and theme overrides without modifying saved archives or Docker data', async () => {
  const uploaded = await wallpapers.upload(7, png);
  await desktop.write(7, {
    ...DEFAULT_DESKTOP_PREFERENCES,
    serverName: 'Saved dashboard',
    workspace: { ...DEFAULT_DESKTOP_PREFERENCES.workspace, pinnedApps: ['jellyfin:fixture'] },
    appearance: { ...DEFAULT_DESKTOP_PREFERENCES.appearance, wallpaperImage: uploaded.hash, dockPins: ['jellyfin:fixture'] },
    wallpaperMode: 'custom',
  });
  await themes.update(7, { expectedRevision: 0, theme: { id: 'orbis-builtin', version: '1.0.0' }, values: [{ key: 'accent', value: '#123456' }] });
  await backup();
  const preserved = await fs.readFile(path.join(root, 'exports/saved.orbis-settings'));
  await fs.mkdir(path.join(root, 'app-data'), { mode: 0o700 });
  await fs.writeFile(path.join(root, 'app-data/media'), 'unchanged media');
  await desktop.write(7, { ...DEFAULT_DESKTOP_PREFERENCES, serverName: 'Later dashboard', preset: 'ocean' });
  await themes.update(7, { expectedRevision: 1, theme: { id: 'orbis-builtin', version: '1.0.0' }, values: [{ key: 'accent', value: '#654321' }] });
  await config.adoptRestoredUserSettingsRuntime({ ...runtime(), timeZone: 'Europe/London' });
  await fs.writeFile(path.join(root, 'state/settings.json'), JSON.stringify({ timeZone: 'Europe/London', guestDashboard: true }), { mode: 0o600 });
  stabilizeExistingDarwinFixtures(root);
  const checked = await review();
  const accepted = await apply.accept(checked.importId, 7, request, credentials, checked.selection, passphrase);
  accepted.start();
  expect((await terminal(accepted.job.id))?.status).toBe('succeeded');
  expect(await desktop.read(7)).toMatchObject({
    serverName: 'Saved dashboard',
    workspace: { pinnedApps: ['jellyfin:fixture'] },
    appearance: { dockPins: ['jellyfin:fixture'] },
  });
  expect((await wallpapers.read(7, uploaded.hash)).data.equals(png)).toBe(true);
  expect((await themes.snapshot(7)).current.values.find((value) => value.key === 'accent')?.value).toBe('#123456');
  expect((await themes.snapshot(7)).revision).toBe(3);
  expect(config.get('userSettings').timeZone).toBe('UTC');
  expect(await fs.readFile(path.join(root, 'exports/saved.orbis-settings'))).toEqual(preserved);
  expect(await fs.readFile(path.join(root, 'app-data/media'), 'utf8')).toBe('unchanged media');
  expect((await imports.list(7)).jobs.find((value) => value.id === checked.importId)?.status).toBe('consumed');
});

it('narrows verified contents to dashboard only and preserves later server, theme and wallpaper choices', async () => {
  await desktop.write(7, {
    ...DEFAULT_DESKTOP_PREFERENCES,
    workspace: { ...DEFAULT_DESKTOP_PREFERENCES.workspace, pinnedApps: ['jellyfin:fixture'] },
  });
  await backup();
  await desktop.write(7, { ...DEFAULT_DESKTOP_PREFERENCES, serverName: 'Keep current name', preset: 'ocean' });
  const checked = await review();
  checked.selection.contents = { version: 1, settings: false, dashboard: true, wallpapers: false, themes: false, timeMachine: [] };
  const accepted = await apply.accept(checked.importId, 7, request, credentials, checked.selection, passphrase);
  accepted.start();
  expect((await terminal(accepted.job.id))?.status).toBe('succeeded');
  expect(await desktop.read(7)).toMatchObject({ serverName: 'Keep current name', preset: 'ocean', workspace: { pinnedApps: ['jellyfin:fixture'] } });
});

it('rolls back both files and the runtime cache if committing the durable completion fails', async () => {
  await backup();
  await desktop.write(7, { ...DEFAULT_DESKTOP_PREFERENCES, serverName: 'Keep previous' });
  await config.adoptRestoredUserSettingsRuntime({ ...runtime(), timeZone: 'Europe/London' });
  await fs.writeFile(path.join(root, 'state/settings.json'), JSON.stringify({ timeZone: 'Europe/London' }), { mode: 0o600 });
  stabilizeExistingDarwinFixtures(root);
  const before = await fs.readFile(path.join(root, 'state/settings.json'));
  const checked = await review();
  const rename = fs.rename.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('/journal.json')) {
      const value = JSON.parse(await fs.readFile(from, 'utf8'));
      if (value.phase === 'complete') throw new Error('Simulated durable commit failure');
    }
    return rename(from, to);
  });
  const accepted = await apply.accept(checked.importId, 7, request, credentials, checked.selection, passphrase);
  accepted.start();
  expect((await terminal(accepted.job.id))?.status).toBe('rolled-back');
  expect(await fs.readFile(path.join(root, 'state/settings.json'))).toEqual(before);
  expect((await desktop.read(7)).serverName).toBe('Keep previous');
  expect(config.get('userSettings').timeZone).toBe('Europe/London');
});

it('reopens an interrupted reservation as recovery-required and permits an authenticated rollback without replaying it', async () => {
  await backup();
  const checked = await review();
  const accepted = await apply.accept(checked.importId, 7, request, credentials, checked.selection, passphrase);
  await apply.onModuleDestroy();
  apply = build();
  await apply.prepareStartup();
  expect(backupMaintenanceActive()).toBe(true);
  expect((await apply.status(7)).job?.needsRecovery).toBe(true);
  await expect(apply.rollback(accepted.job.id, 8, request, credentials)).rejects.toThrow();
  expect((await apply.rollback(accepted.job.id, 7, request, credentials)).status).toBe('rolled-back');
  expect(backupMaintenanceActive()).toBe(false);
  accepted.start();
  expect((await apply.status(7)).job?.status).toBe('rolled-back');
});
