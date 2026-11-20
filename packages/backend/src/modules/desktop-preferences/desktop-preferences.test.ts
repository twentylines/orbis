import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { type INestApplication, type NestMiddleware } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ArkValidationPipe } from 'nestjs-arktype';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { AuthGuard } from '../auth/auth.guard';
import { DesktopPreferencesController } from './desktop-preferences.controller';
import { DEFAULT_DESKTOP_PREFERENCES, DesktopPreferencesService } from './desktop-preferences.service';
import { DesktopWallpaperService } from './desktop-wallpaper.service';
import { ResetState } from '../system-reset/reset-state';
import { mergeSettingsPreferences, splitSettingsPreferences } from '../system-backups/settings-backup-preferences';
import { randomUUID } from 'node:crypto';

describe('desktop preferences', () => {
  let directory: string;
  let app: INestApplication;

  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtipi-desktop-test-'));
    const config = mock<ConfigurationService>();
    config.get.calledWith('directories').mockReturnValue({ dataDir: directory } as never);
    const module = await Test.createTestingModule({
      controllers: [DesktopPreferencesController],
      providers: [
        AuthGuard,
        DesktopPreferencesService,
        DesktopWallpaperService,
        { provide: ConfigurationService, useValue: config },
        { provide: LoggerService, useValue: mock<LoggerService>() },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use(((req, _res, next) => {
      if (req.headers.authorization === 'Bearer test') req.user = { id: 7 };
      if (req.headers.authorization === 'Bearer other') req.user = { id: 8 };
      next();
    }) as NestMiddleware['use']);
    app.useGlobalPipes(new ArkValidationPipe());
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('requires authentication for reading and writing', async () => {
    expect((await request(app.getHttpServer()).get('/desktop-preferences')).status).toBe(401);
    expect((await request(app.getHttpServer()).put('/desktop-preferences').send(DEFAULT_DESKTOP_PREFERENCES)).status).toBe(401);
    expect((await request(app.getHttpServer()).get('/desktop-preferences/onboarding')).status).toBe(401);
    expect((await request(app.getHttpServer()).post('/desktop-preferences/onboarding')).status).toBe(401);
  });

  it('new and reset preferences follow System without changing an explicit user mode', async () => {
    expect(DEFAULT_DESKTOP_PREFERENCES.mode).toBe('system');
    expect((await app.get(DesktopPreferencesService).read(9876)).mode).toBe('system');
  });

  it('defaults logical processors on and persists an explicit off choice through authenticated PUT, disk and GET', async () => {
    const file = path.join(directory, 'state', 'desktop', '7.json');
    const authorization = 'Bearer test';
    const service = app.get(DesktopPreferencesService);
    const { showLogicalProcessors: _monitor, ...legacy } = DEFAULT_DESKTOP_PREFERENCES;
    const get = () => request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', authorization);
    const put = (body: object) => request(app.getHttpServer()).put('/desktop-preferences').set('Authorization', authorization).send(body);
    try {
      expect((await get().expect(200)).body.showLogicalProcessors).toBe(true);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(legacy), { mode: 0o600 });
      expect((await get().expect(200)).body.showLogicalProcessors).toBe(true);
      expect((await put({ ...legacy, showLogicalProcessors: false }).expect(200)).body.showLogicalProcessors).toBe(false);
      expect(JSON.parse(await fs.readFile(file, 'utf8')).showLogicalProcessors).toBe(false);
      expect((await new DesktopPreferencesService(app.get(ConfigurationService)).read(7)).showLogicalProcessors).toBe(false);
      expect((await get().expect(200)).body.showLogicalProcessors).toBe(false);
      const sections = splitSettingsPreferences(await service.backupSnapshot(7));
      expect(sections.settings.showLogicalProcessors).toBe(false);
      expect(mergeSettingsPreferences(DEFAULT_DESKTOP_PREFERENCES, sections).showLogicalProcessors).toBe(false);
      expect((await put({ ...legacy, preset: 'forest' }).expect(200)).body).toMatchObject({ showLogicalProcessors: false, preset: 'forest' });
      await put({ ...legacy, showLogicalProcessors: 'false' }).expect(400);
      expect((await service.read(7)).showLogicalProcessors).toBe(false);
      expect((await service.read(8)).showLogicalProcessors).toBe(true);
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it('announces onboarding completion to both connected clients of its account', async () => {
    const service = app.get(DesktopPreferencesService);
    const first: unknown[] = [];
    const second: unknown[] = [];
    const subscriptions = [
      service.changesFor(7).subscribe((event) => first.push(event.data)),
      service.changesFor(7).subscribe((event) => second.push(event.data)),
    ];
    try {
      await request(app.getHttpServer()).post('/desktop-preferences/onboarding').set('Authorization', 'Bearer test').expect(201);
      expect(first).toEqual([{ changed: true }]);
      expect(second).toEqual(first);
    } finally {
      for (const subscription of subscriptions) subscription.unsubscribe();
      await fs.rm(path.join(directory, 'state', 'onboarding', '7.json'), { force: true });
    }
  });

  it('rejects stale and generationless HTTP writes after reset while allowing fresh clients and internal recovery', async () => {
    const reset = new ResetState(directory);
    const id = randomUUID();
    await reset.save({ version: 1, id, controller: 'fixture', users: [7, 8], accounts: 'keep', phase: 'complete', createdAt: Date.now() });
    try {
      const read = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test').expect(200);
      expect(read.headers['x-orbis-reset-generation']).toBe(id);
      const pinned = { ...DEFAULT_DESKTOP_PREFERENCES, workspace: { ...DEFAULT_DESKTOP_PREFERENCES.workspace, pinnedApps: ['media:fixture'] } };
      for (const generation of [undefined, 'none', randomUUID()]) {
        const put = request(app.getHttpServer()).put('/desktop-preferences').set('Authorization', 'Bearer test');
        const setup = request(app.getHttpServer()).post('/desktop-preferences/onboarding').set('Authorization', 'Bearer test');
        if (generation) {
          put.set('X-Orbis-Reset-Generation', generation);
          setup.set('X-Orbis-Reset-Generation', generation);
        }
        await put.send(pinned).expect(409);
        await setup.expect(409);
      }
      expect((await app.get(DesktopPreferencesService).read(7)).workspace?.pinnedApps).toEqual([]);
      await request(app.getHttpServer())
        .put('/desktop-preferences')
        .set('Authorization', 'Bearer test')
        .set('X-Orbis-Reset-Generation', id)
        .send(DEFAULT_DESKTOP_PREFERENCES)
        .expect(200);
      await request(app.getHttpServer())
        .post('/desktop-preferences/onboarding')
        .set('Authorization', 'Bearer test')
        .set('X-Orbis-Reset-Generation', id)
        .expect(201);
      await app.get(DesktopPreferencesService).write(7, DEFAULT_DESKTOP_PREFERENCES);
    } finally {
      await fs.rm(path.join(directory, 'state', 'orbis-reset'), { recursive: true, force: true });
      await fs.rm(path.join(directory, 'state', 'onboarding', '7.json'), { force: true });
    }
  });

  it('advertises durable layout support and retains toolbar, icon view and widget sizes across service reload', async () => {
    const before = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer other').expect(200);
    expect(before.headers['x-orbis-preference-capabilities']).toBe('workspace-layout-v1 toolbar-order-v1');
    const value = {
      ...DEFAULT_DESKTOP_PREFERENCES,
      toolbarOrder: ['search', 'mode', 'tasks', 'battery', 'logout', 'connection'],
      workspace: {
        ...DEFAULT_DESKTOP_PREFERENCES.workspace,
        layout: { version: 1, appView: 'icons', widgets: { activity: { columns: 3, height: 480 } } },
      },
    };
    await request(app.getHttpServer()).put('/desktop-preferences').set('Authorization', 'Bearer other').send(value).expect(200);
    const reloaded = new DesktopPreferencesService(app.get(ConfigurationService));
    expect(await reloaded.read(8)).toMatchObject(value);
    expect((await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer other').expect(200)).body).toMatchObject(
      value,
    );
    await reloaded.write(8, DEFAULT_DESKTOP_PREFERENCES);
  });

  it('defaults old account preferences to 12-hour display and persists each account clock format independently', async () => {
    const { timeFormat: _removed, ...appearance } = DEFAULT_DESKTOP_PREFERENCES.appearance ?? {};
    await fs.mkdir(path.join(directory, 'state', 'desktop'), { recursive: true });
    await fs.writeFile(path.join(directory, 'state', 'desktop', '7.json'), JSON.stringify({ ...DEFAULT_DESKTOP_PREFERENCES, appearance }));
    const legacy = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test').expect(200);
    expect(legacy.body.appearance.timeFormat).toBe('12h');
    await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, appearance: { timeFormat: '24h' } })
      .expect(200);
    const saved = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test').expect(200);
    expect(saved.body.appearance.timeFormat).toBe('24h');
    const other = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer other').expect(200);
    expect(other.body.appearance.timeFormat).toBe('12h');
    for (const timeFormat of [null, 12, '12', '24', 'auto']) {
      await request(app.getHttpServer())
        .put('/desktop-preferences')
        .set('Authorization', 'Bearer test')
        .send({ ...DEFAULT_DESKTOP_PREFERENCES, appearance: { timeFormat } })
        .expect(400);
    }
    expect(
      (await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test').expect(200)).body.appearance.timeFormat,
    ).toBe('24h');
    await request(app.getHttpServer()).put('/desktop-preferences').set('Authorization', 'Bearer test').send(DEFAULT_DESKTOP_PREFERENCES).expect(200);
  });

  it('announces saved preferences only to clients belonging to that account', async () => {
    const service = app.get(DesktopPreferencesService);
    const first: unknown[] = [];
    const second: unknown[] = [];
    const one = service.changesFor(7).subscribe((event) => first.push(event.data));
    const two = service.changesFor(8).subscribe((event) => second.push(event.data));
    try {
      await request(app.getHttpServer())
        .put('/desktop-preferences')
        .set('Authorization', 'Bearer test')
        .send({ ...DEFAULT_DESKTOP_PREFERENCES, mode: 'dark' })
        .expect(200);
      expect(first).toEqual([{ changed: true }]);
      expect(second).toEqual([]);
      await request(app.getHttpServer())
        .put('/desktop-preferences')
        .set('Authorization', 'Bearer other')
        .send({ ...DEFAULT_DESKTOP_PREFERENCES, mode: 'light' })
        .expect(200);
      expect(first).toHaveLength(1);
      expect(second).toEqual([{ changed: true }]);
      const saved = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test').expect(200);
      expect(saved.body.mode).toBe('dark');
    } finally {
      one.unsubscribe();
      two.unsubscribe();
    }
  });

  it('keeps first-run setup separate from inherited accounts and appearance settings', async () => {
    const status = () => request(app.getHttpServer()).get('/desktop-preferences/onboarding').set('Authorization', 'Bearer test');
    expect((await status()).body).toEqual({ complete: false });
    await request(app.getHttpServer()).put('/desktop-preferences').set('Authorization', 'Bearer test').send(DEFAULT_DESKTOP_PREFERENCES).expect(200);
    expect((await status()).body).toEqual({ complete: false });
    await request(app.getHttpServer()).post('/desktop-preferences/onboarding').set('Authorization', 'Bearer test').expect(201, { complete: true });
    const stored = path.join(directory, 'state', 'onboarding', '7.json');
    expect((await fs.stat(stored)).mode & 0o777).toBe(0o600);
    await request(app.getHttpServer()).put('/desktop-preferences').set('Authorization', 'Bearer test').send(DEFAULT_DESKTOP_PREFERENCES).expect(200);
    expect((await status()).body).toEqual({ complete: true });
    const other = await request(app.getHttpServer()).get('/desktop-preferences/onboarding').set('Authorization', 'Bearer other').expect(200);
    expect(other.body).toEqual({ complete: false });
    await fs.rm(stored);
  });

  it('shortens onboarding only for an authenticated installer-marked Runtipi migration', async () => {
    const marker = path.join(directory, '.orbis-onboarding-origin.json');
    const status = () => request(app.getHttpServer()).get('/desktop-preferences/onboarding').set('Authorization', 'Bearer test');
    try {
      await fs.writeFile(marker, JSON.stringify({ version: 1, source: 'runtipi' }), { mode: 0o644 });
      expect((await status()).body).toEqual({ complete: false, entry: 'runtipi' });
      expect((await request(app.getHttpServer()).get('/desktop-preferences/onboarding')).status).toBe(401);
      await fs.writeFile(marker, JSON.stringify({ version: 1, source: 'docker' }));
      expect((await status()).body).toEqual({ complete: false });
      await fs.writeFile(marker, JSON.stringify({ version: 1, source: 'runtipi', authentication: true }));
      expect((await status()).body).toEqual({ complete: false });
      await fs.rm(marker);
      await fs.symlink(path.join(directory, 'state', 'desktop', '7.json'), marker);
      expect((await status()).body).toEqual({ complete: false });
    } finally {
      await fs.rm(marker, { force: true });
    }
  });

  it('persists validated preferences per user and rejects invalid values', async () => {
    await fs.rm(path.join(directory, 'state', 'desktop', '7.json'), { force: true });
    const initial = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test');
    expect(initial.body).toEqual(DEFAULT_DESKTOP_PREFERENCES);
    expect(initial.body.serverName).toBe('Server');

    const invalid = await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ serverName: '', preset: 'unknown', density: 'compact' });
    expect(invalid.status).toBe(400);

    const value = { serverName: 'Workshop', preset: 'forest', density: 'compact' };
    const saved = await request(app.getHttpServer()).put('/desktop-preferences').set('Authorization', 'Bearer test').send(value);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ ...DEFAULT_DESKTOP_PREFERENCES, ...value });
    const fetched = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test');
    expect(fetched.body).toEqual({ ...DEFAULT_DESKTOP_PREFERENCES, ...value });
    const file = await fs.stat(path.join(directory, 'state', 'desktop', '7.json'));
    expect(file.mode & 0o777).toBe(0o600);
  });

  it('preserves earlier saved settings while adding a wallpaper choice', async () => {
    await fs.writeFile(
      path.join(directory, 'state', 'desktop', '7.json'),
      JSON.stringify({ serverName: 'Workshop', preset: 'stone', density: 'compact' }),
    );
    const fetched = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test');
    expect(fetched.body).toEqual({ ...DEFAULT_DESKTOP_PREFERENCES, serverName: 'Workshop', preset: 'stone', density: 'compact' });
    const changed = await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ serverName: 'Workshop', preset: 'ocean', density: 'compact', wallpaper: 'tidal' });
    expect(changed.status).toBe(200);
    expect(changed.body.wallpaper).toBe('tidal');
  });

  it('stores theme-following and manual landscapes without changing the legacy wallpaper contract', async () => {
    const value = {
      ...DEFAULT_DESKTOP_PREFERENCES,
      serverName: 'Hades',
      preset: 'blush',
      wallpaper: 'sandstone',
      wallpaperMode: 'custom',
      wallpaperPreset: 'ocean',
    };
    await request(app.getHttpServer()).put('/desktop-preferences').set('Authorization', 'Bearer test').send(value).expect(200);
    const saved = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test').expect(200);
    expect(saved.body).toMatchObject({
      wallpaper: 'sandstone',
      wallpaperMode: 'custom',
      wallpaperPreset: 'ocean',
      preset: 'blush',
      serverName: 'Hades',
    });
    await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...value, wallpaper: 'ocean' })
      .expect(400);
    await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...value, wallpaperPreset: 'https://example.com/photo' })
      .expect(400);
    await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ serverName: 'Hades', preset: 'blush', density: 'comfortable', wallpaper: 'tidal' })
      .expect(200);
    const legacy = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test').expect(200);
    expect(legacy.body.wallpaperMode).toBe('theme');
  });

  it('persists light and dark mode and migrates older Graphite settings', async () => {
    const file = path.join(directory, 'state', 'desktop', '7.json');
    await fs.writeFile(file, JSON.stringify({ serverName: 'Workshop', preset: 'graphite', density: 'compact' }));
    const inherited = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test');
    expect(inherited.body.mode).toBe('dark');

    const light = await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...inherited.body, mode: 'light' });
    expect(light.status).toBe(200);
    expect(light.body.mode).toBe('light');
    const fetched = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test');
    expect(fetched.body.mode).toBe('light');

    const invalid = await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...inherited.body, mode: 'auto' });
    expect(invalid.status).toBe(400);
  });

  it('persists the system colour preference without resolving it on the server', async () => {
    const value = { ...DEFAULT_DESKTOP_PREFERENCES, mode: 'system', preset: 'blush' };
    const saved = await request(app.getHttpServer()).put('/desktop-preferences').set('Authorization', 'Bearer test').send(value);
    expect(saved.status).toBe(200);
    expect(saved.body.mode).toBe('system');
    const stored = JSON.parse(await fs.readFile(path.join(directory, 'state', 'desktop', '7.json'), 'utf8'));
    expect(stored.mode).toBe('system');
    const fetched = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test');
    expect(fetched.body.mode).toBe('system');
    expect(fetched.body.preset).toBe('blush');
  });

  it('saves a widget layout and rejects duplicate or unknown widget IDs', async () => {
    const workspace = { order: ['activity', 'applications', 'storage', 'attention'], hidden: ['attention'], wide: ['applications'] };
    const saved = await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, workspace });
    expect(saved.status).toBe(200);
    expect(saved.body.workspace).toEqual({ ...workspace, pinnedApps: [], showAllApps: false });
    const invalid = await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, workspace: { ...workspace, order: ['activity', 'activity', 'storage', 'attention'] } });
    expect(invalid.status).toBe(400);
    const unknown = await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, workspace: { ...workspace, hidden: ['admin-shell'] } });
    expect(unknown.status).toBe(400);
  });

  it('persists showing every app independently of widget visibility', async () => {
    const workspace = { ...DEFAULT_DESKTOP_PREFERENCES.workspace, showAllApps: true, pinnedApps: ['whoami:migrated'] };
    const saved = await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, workspace });
    expect(saved.status).toBe(200);
    const hidden = { ...workspace, hidden: ['storage', 'attention'] };
    await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, workspace: hidden })
      .expect(200);
    const fetched = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test');
    expect(fetched.body.workspace).toEqual(hidden);
  });

  it.each(['true', 'all', 1, null])('rejects invalid show-all preference %s', async (showAllApps) => {
    const invalid = await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, workspace: { ...DEFAULT_DESKTOP_PREFERENCES.workspace, showAllApps } });
    expect(invalid.status).toBe(400);
  });

  it('keeps old widget layouts and validates pinned app identities', async () => {
    const workspace = { order: ['applications', 'activity', 'storage', 'attention'], hidden: [], wide: ['applications'] };
    await fs.writeFile(path.join(directory, 'state', 'desktop', '7.json'), JSON.stringify({ ...DEFAULT_DESKTOP_PREFERENCES, workspace }));
    const inherited = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test');
    expect(inherited.body.workspace).toEqual({ ...workspace, pinnedApps: [], showAllApps: false });
    const saved = await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, workspace: { ...workspace, pinnedApps: ['whoami:migrated'] } });
    expect(saved.status).toBe(200);
    expect(saved.body.workspace.pinnedApps).toEqual(['whoami:migrated']);
    const invalid = await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, workspace: { ...workspace, pinnedApps: ['whoami:migrated', 'whoami:migrated'] } });
    expect(invalid.status).toBe(400);
    const malformed = await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, workspace: { ...workspace, pinnedApps: [':migrated'] } });
    expect(malformed.status).toBe(400);
  });

  it('saves and reorders large pin lists without truncating legacy or unavailable identities', async () => {
    const pins = Array.from({ length: 512 }, (_, index) => `app-${index}:store`);
    const workspace = { ...DEFAULT_DESKTOP_PREFERENCES.workspace, pinnedApps: pins };
    await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, workspace })
      .expect(200);
    const reordered = [...pins.slice(1), pins[0]];
    await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, workspace: { ...workspace, pinnedApps: reordered } })
      .expect(200);
    const fetched = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test').expect(200);
    expect(fetched.body.workspace.pinnedApps).toEqual(reordered);
    const stored = JSON.parse(await fs.readFile(path.join(directory, 'state', 'desktop', '7.json'), 'utf8'));
    expect(stored.workspace.pinnedApps).toEqual(reordered);
    await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, workspace: { ...workspace, pinnedApps: [...pins, 'overflow:store'] } })
      .expect(400);
  });

  it('round-trips independent window placements and supplies defaults for legacy accounts', async () => {
    const windows = {
      settings: { mode: 'floating', bounds: { x: 60, y: 120, width: 900, height: 600 } },
      monitor: { mode: 'maximized', restoreMode: 'left', bounds: { x: 100, y: 160, width: 600, height: 480 } },
    };
    const saved = await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, windows })
      .expect(200);
    expect(saved.body.windows).toEqual(windows);
    const fetched = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test').expect(200);
    expect(fetched.body.windows).toEqual(windows);
    await fs.writeFile(
      path.join(directory, 'state', 'desktop', '7.json'),
      JSON.stringify({ serverName: 'Workshop', preset: 'forest', density: 'compact' }),
    );
    const legacy = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test').expect(200);
    expect(legacy.body.windows).toEqual({});
  });

  it('round-trips app opening choices and sizes per account without storing app URLs', async () => {
    const appLaunch = { mode: 'window', apps: { 'notes:store': { mode: 'tab', bounds: { x: 24, y: 120, width: 900, height: 600 } } } };
    await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, appLaunch })
      .expect(200);
    const saved = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer test').expect(200);
    expect(saved.body.appLaunch).toEqual(appLaunch);
    const other = await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer other').expect(200);
    expect(other.body.appLaunch).toEqual(DEFAULT_DESKTOP_PREFERENCES.appLaunch);
    for (const apps of [{ 'notes:store': { url: 'https://secret.local' } }, { 'notes:store': { mode: 'popup' } }, { constructor: {} }]) {
      await request(app.getHttpServer())
        .put('/desktop-preferences')
        .set('Authorization', 'Bearer test')
        .send({ ...DEFAULT_DESKTOP_PREFERENCES, appLaunch: { ...appLaunch, apps } })
        .expect(400);
    }
  });

  it('stores only declared appearance and workspace fields', async () => {
    const saved = await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({
        ...DEFAULT_DESKTOP_PREFERENCES,
        unrelated: 'do not store',
        workspace: { ...DEFAULT_DESKTOP_PREFERENCES.workspace, unrelated: 'do not store' },
      })
      .expect(200);
    expect(saved.body).toEqual(DEFAULT_DESKTOP_PREFERENCES);
    const disk = JSON.parse(await fs.readFile(path.join(directory, 'state', 'desktop', '7.json'), 'utf8'));
    expect(disk).toEqual(DEFAULT_DESKTOP_PREFERENCES);
  });

  it.each([
    { terminal: { mode: 'focused', bounds: { x: 0, y: 0, width: 800, height: 500 } } },
    { settings: { mode: 'unknown', bounds: { x: 0, y: 0, width: 800, height: 500 } } },
    { settings: { mode: 'floating', bounds: { x: -1, y: 0, width: 800, height: 500 } } },
    { settings: { mode: 'floating', bounds: { x: 0, y: 0, width: 800.5, height: 500 } } },
    { settings: { mode: 'floating', bounds: { x: 0, y: 0, width: 9000, height: 500 } } },
    { settings: { mode: 'floating', bounds: { x: 0, y: 0, width: 800, height: 500 }, draft: 'must not persist' } },
    { settings: { mode: 'floating', bounds: { x: 0, y: 0, width: 800, height: 500, url: 'https://example.com' } } },
  ])('rejects unsupported or unsafe window state %#', async (windows) => {
    await request(app.getHttpServer())
      .put('/desktop-preferences')
      .set('Authorization', 'Bearer test')
      .send({ ...DEFAULT_DESKTOP_PREFERENCES, windows })
      .expect(400);
  });
  it('round-trips bounded accent, material, text and effect settings without accepting invalid overrides', async () => {
    const value = {
      ...DEFAULT_DESKTOP_PREFERENCES,
      appearance: {
        ...DEFAULT_DESKTOP_PREFERENCES.appearance,
        accent: '#ffff00',
        themeColour: '#a82444',
        wallpaperColours: true,
        textScale: 150,
        surfaceOpacity: 37,
        chromeOpacity: 0,
        glassBlur: 40,
        chromeBlur: 64,
        glassTint: 30,
        materialMode: 'custom',
        motion: 'reduced',
        transparency: 'solid',
        lowEffects: true,
      },
    };
    const put = (appearance: unknown) =>
      request(app.getHttpServer())
        .put('/desktop-preferences')
        .set('Authorization', 'Bearer other')
        .send({ ...value, appearance });
    await put(value.appearance).expect(200);
    await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer other').expect(200, value);
    const file = path.join(directory, 'state', 'desktop', '8.json');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).appearance).toEqual(value.appearance);
    const reloaded = new DesktopPreferencesService(app.get(ConfigurationService));
    expect(await reloaded.read(8)).toEqual(value);
    for (const invalid of [
      { accent: 'red' },
      { themeColour: 'red' },
      { materialMode: 'automatic' },
      { wallpaperColours: 'true' },
      { wallpaperUnsplash: 'https://images.example/not-an-id' },
      { textScale: 84 },
      { textScale: 151 },
      { textScale: 125.5 },
      { textScale: '150' },
      { chromeOpacity: -1 },
      { chromeOpacity: 101 },
      { chromeOpacity: 0.5 },
      { chromeOpacity: '37' },
      { surfaceOpacity: -1 },
      { surfaceOpacity: 101 },
      { surfaceOpacity: 0.5 },
      { surfaceOpacity: '37' },
      { glassBlur: 41 },
      { chromeBlur: 65 },
      { chromeBlur: -1 },
      { glassTint: 31 },
      { lowEffects: 'true' },
      { motion: 'full' },
      { transparency: 'transparent' },
    ]) {
      await put({ ...value.appearance, ...invalid }).expect(400);
    }
    await request(app.getHttpServer()).get('/desktop-preferences').set('Authorization', 'Bearer other').expect(200, value);
    const transparent = { ...value.appearance, materialMode: 'default', transparency: 'glass' };
    await put(transparent).expect(200, { ...value, appearance: transparent });
    expect((await reloaded.read(8)).appearance).toEqual(transparent);
    const reset = { ...transparent, surfaceOpacity: null, chromeOpacity: null, themeColour: null };
    await put(reset).expect(200, { ...value, appearance: reset });
    expect((await reloaded.read(8)).appearance).toEqual(reset);
  });

  it('loads legacy opacity overrides without rewriting disk and accepts the new desktop and wallpaper presets', async () => {
    const file = path.join(directory, 'state', 'desktop', '7.json');
    const appearance = JSON.stringify({ transparency: 'system', surfaceOpacity: 94, chromeOpacity: 82 });
    const saved = { ...DEFAULT_DESKTOP_PREFERENCES, appearance: JSON.parse(appearance) };
    const legacy = JSON.stringify(saved);
    const auth = { Authorization: 'Bearer test' };
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, legacy, { mode: 0o600 });
      const get = () => request(app.getHttpServer()).get('/desktop-preferences').set(auth);
      expect((await get().expect(200)).body.appearance).toMatchObject({
        materialMode: 'custom',
        transparency: 'system',
        surfaceOpacity: 94,
        chromeOpacity: 82,
        themeColour: null,
      });
      expect(await fs.readFile(file, 'utf8')).toBe(legacy);
      for (const preset of ['burgundy', 'amber', 'rose', 'orange'] as const) {
        const next = { ...saved, preset, wallpaperMode: 'custom', wallpaperPreset: preset };
        await request(app.getHttpServer()).put('/desktop-preferences').set(auth).send(next).expect(200);
        expect((await get().expect(200)).body).toMatchObject({ preset, wallpaperPreset: preset });
      }
    } finally {
      await fs.rm(file, { force: true });
    }
  });
});
