import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomaticUpdatesService } from './automatic-updates.service';
import { MonitoringActivityService } from '@/core/monitoring/monitoring-activity.service';
import {
  automaticUpdateStateSchema,
  dailyUpdateSlot,
  parseAppUpdateRule,
  parseAutomaticSettings,
  type AutomaticUpdateAttempt,
} from './automatic-updates.model';
import { syncHash } from '../cluster/cluster-sync.schema';

const settings = (enabled = true, mode: 'idle' | 'scheduled' = 'idle', time = '03:00') => ({
  orbis: { enabled, mode },
  schedule: { time, timezone: 'UTC' },
});
const healthy = {
  available: true,
  enrolled: true,
  imageMatches: true,
  coreState: 'running',
  coreHealth: 'healthy',
  currentTag: 'v0.1.0-beta.91',
  job: null,
};
const plan = {
  planId: 'reviewed',
  currentTag: 'v0.1.0-beta.91',
  targetTag: 'v0.1.0-beta.92',
  targetDigest: `sha256:${'a'.repeat(64)}`,
  snapshotBytes: 100,
  appsMustBeStopped: false,
};

describe('server automatic update scheduling', () => {
  let directory: string;
  let activity: MonitoringActivityService;
  let automatic: AutomaticUpdatesService;
  let serverZone: unknown;
  const host = { status: vi.fn(), plan: vi.fn(), apply: vi.fn() };
  const releases = { latest: vi.fn() };
  const channels = { read: vi.fn(async () => ({ version: 1 as const, channel: 'nightly' as const, revision: 'initial' })) };
  const apps = { getApps: vi.fn(), getAppByUrn: vi.fn() };
  const marketplace = { getAppUpdateInfo: vi.fn() };
  const lifecycle = { updateApp: vi.fn() };
  const logger = { warn: vi.fn() };
  const config = { get: vi.fn() };
  const quiet = () => vi.setSystemTime(Date.now() + 11 * 60_000);
  const create = () =>
    new AutomaticUpdatesService(
      config as never,
      host as never,
      releases as never,
      activity,
      apps as never,
      marketplace as never,
      lifecycle as never,
      logger as never,
      channels as never,
    );
  const installedApps = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ appName: `app${index}`, appStoreSlug: 'tipi', status: 'running' }));
  const attempt = (state: AutomaticUpdateAttempt['state'] = 'no-update', targetVersion?: number): AutomaticUpdateAttempt => ({
    slot: 'old-day/03:00/UTC',
    state,
    at: Date.now(),
    message: 'Previous check',
    ...(targetVersion === undefined ? {} : { targetVersion }),
  });
  const stored = async () => JSON.parse(await fs.readFile(path.join(directory, 'state', 'automatic-updates', 'settings.json'), 'utf8'));
  const warningFile = () => path.join(directory, 'state', 'automatic-updates', 'app-capacity-warning.json');
  const seedHistory = async (history: Record<string, AutomaticUpdateAttempt>, rules = {}, enabled = true) => {
    await automatic.update({ ...settings(false), apps: { enabled } });
    const next = { ...(await stored()), apps: history, rules };
    expect(automaticUpdateStateSchema.allows(next)).toBe(true);
    await fs.writeFile(path.join(directory, 'state', 'automatic-updates', 'settings.json'), JSON.stringify(next));
    automatic.onModuleDestroy();
    automatic = create();
    await automatic.onModuleInit();
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T03:20:00Z'));
    vi.stubEnv('ORBIS_VERSION', 'v0.1.0-beta.91');
    directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-automatic-test-')));
    serverZone = 'UTC';
    config.get
      .mockReset()
      .mockImplementation((key: string) =>
        key === 'directories' ? { dataDir: directory } : key === 'userSettings' ? { timeZone: serverZone } : false,
      );
    host.status.mockReset().mockResolvedValue(healthy);
    host.plan.mockReset().mockResolvedValue(plan);
    host.apply.mockReset().mockResolvedValue({ jobId: 'accepted-job', state: 'running' });
    releases.latest.mockReset().mockResolvedValue({
      tag: 'v0.1.0-beta.92',
      imageManifestUrl: 'https://github.com/twentylines/orbis/releases/download/v0.1.0-beta.92/release-manifest.json',
    });
    channels.read.mockReset().mockResolvedValue({ version: 1, channel: 'nightly', revision: 'initial' });
    apps.getApps.mockReset().mockResolvedValue([]);
    apps.getAppByUrn.mockReset().mockResolvedValue({ version: 1, ignoredVersion: null, status: 'running', appStoreSlug: 'tipi' });
    marketplace.getAppUpdateInfo.mockReset().mockResolvedValue({ latestVersion: 2 });
    lifecycle.updateApp.mockReset().mockResolvedValue({ requestId: 'app-request' });
    logger.warn.mockReset();
    activity = new MonitoringActivityService();
    automatic = create();
    await automatic.onModuleInit();
  });
  afterEach(async () => {
    automatic.onModuleDestroy();
    activity.onModuleDestroy();
    await fs.rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('defaults Orbis and every app off without a timer, network check or operation', async () => {
    quiet();
    await automatic.tick();
    expect((await automatic.read()).settings.orbis.enabled).toBe(false);
    expect((await automatic.readApp('adguard:tipi')).rule.mode).toBe('disabled');
    expect(vi.getTimerCount()).toBe(0);
    expect(host.status).not.toHaveBeenCalled();
    expect(releases.latest).not.toHaveBeenCalled();
    expect(lifecycle.updateApp).not.toHaveBeenCalled();
  });

  it('reports the configured server timezone and bounded server clock across all schedule reads without enabling updates', async () => {
    serverZone = 'Asia/Singapore';
    const expected = { now: Date.now(), timezone: serverZone };
    expect(await automatic.read()).toMatchObject({
      settings: { orbis: { enabled: false }, schedule: { timezone: serverZone } },
      serverTime: expected,
    });
    expect(await automatic.readSystem()).toMatchObject({ settings: { enabled: false }, shared: { timezone: serverZone }, serverTime: expected });
    expect(await automatic.readApp('adguard:tipi')).toMatchObject({
      rule: { mode: 'disabled' },
      shared: { timezone: serverZone },
      serverTime: expected,
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(host.status).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(directory, 'state/automatic-updates/settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ignores browser timezone input, accepts time-only schedules and preserves explicit disabled choices', async () => {
    serverZone = 'Asia/Singapore';
    const value = await automatic.update({ ...settings(false), schedule: { time: '17:45', timezone: 'invalid/browser-zone' } });
    expect(value.settings).toEqual({ orbis: { enabled: false, mode: 'idle' }, schedule: { time: '17:45', timezone: serverZone } });
    const saved = JSON.parse(await fs.readFile(path.join(directory, 'state/automatic-updates/settings.json'), 'utf8'));
    expect(saved.settings).toEqual(value.settings);
    expect((await automatic.update({ orbis: { enabled: false, mode: 'scheduled' }, schedule: { time: '08:09' } })).settings.schedule).toEqual({
      time: '08:09',
      timezone: serverZone,
    });
    quiet();
    await automatic.tick();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.status).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'invalid/server-zone', 'x'.repeat(101)])('uses the server system timezone for invalid configured case %#', async (zone) => {
    serverZone = zone;
    const fallback = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect((await automatic.read()).settings.schedule.timezone).toBe(fallback);
    expect((await automatic.read()).settings.orbis.enabled).toBe(false);
  });

  it('falls back to UTC when the server system timezone is unusable too', async () => {
    serverZone = 'invalid/server-zone';
    const original = Intl.DateTimeFormat;
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((...args: Parameters<typeof Intl.DateTimeFormat>) => {
      if (args[1]?.timeZone === undefined) throw new RangeError('Synthetic missing system timezone');
      return new original(...args);
    });
    expect((await automatic.read()).serverTime.timezone).toBe('UTC');
  });

  it('uses a changed server timezone after loading legacy schedule state for the next local day', async () => {
    await automatic.update(settings(true, 'scheduled', '05:00'));
    automatic.onModuleDestroy();
    serverZone = 'Asia/Singapore';
    automatic = create();
    await automatic.onModuleInit();
    vi.setSystemTime(new Date('2026-10-24T20:45:00Z'));
    expect((await automatic.read()).settings.schedule.timezone).toBe(serverZone);
    await automatic.tick();
    expect(releases.latest).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-10-24T21:00:00Z'));
    await automatic.tick();
    expect(host.apply).toHaveBeenCalledTimes(1);
    expect((await automatic.read()).lastAttempt?.slot).toBe('2026-10-25/05:00/Asia/Singapore');
  });

  it('uses the effective server timezone for global and custom app schedules', async () => {
    await automatic.update(settings(false, 'idle', '05:00'));
    await automatic.updateApp('global:tipi', { mode: 'global' });
    await automatic.updateApp('custom:tipi', { mode: 'custom', time: '06:00' });
    serverZone = 'Asia/Singapore';
    vi.setSystemTime(new Date('2026-10-24T20:45:00Z'));
    await automatic.tick();
    expect(lifecycle.updateApp).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-10-24T21:00:00Z'));
    await automatic.tick();
    expect(lifecycle.updateApp).toHaveBeenCalledTimes(1);
    expect((await automatic.readApp('global:tipi')).lastAttempt?.slot).toBe('2026-10-25/05:00/Asia/Singapore');
    vi.setSystemTime(new Date('2026-10-24T22:00:00Z'));
    await automatic.tick();
    expect(lifecycle.updateApp).toHaveBeenCalledTimes(2);
    expect((await automatic.readApp('custom:tipi')).lastAttempt?.slot).toBe('2026-10-25/06:00/Asia/Singapore');
    expect((await automatic.read()).settings.orbis.enabled).toBe(false);
  });

  it('does not repeat a configured-server daily check across the autumn DST hour repeat', async () => {
    serverZone = 'America/New_York';
    releases.latest.mockResolvedValue({ tag: healthy.currentTag, imageManifestUrl: 'present' });
    await automatic.update(settings(true, 'scheduled', '01:30'));
    vi.setSystemTime(new Date('2026-11-01T05:45:00Z'));
    await automatic.tick();
    vi.setSystemTime(new Date('2026-11-01T06:45:00Z'));
    await automatic.tick();
    expect(releases.latest).toHaveBeenCalledTimes(1);
    expect((await automatic.read()).lastAttempt?.slot).toBe('2026-11-01/01:30/America/New_York');
  });

  it('reads the selected channel and uses one daily check and pinned host plan/apply across concurrent ticks', async () => {
    await automatic.update(settings());
    await automatic.tick();
    expect(releases.latest).not.toHaveBeenCalled();
    quiet();
    await Promise.all(Array.from({ length: 8 }, () => automatic.tick()));
    await automatic.tick();
    expect(releases.latest).toHaveBeenCalledExactlyOnceWith('nightly');
    expect(host.plan).toHaveBeenCalledExactlyOnceWith('v0.1.0-beta.92');
    expect(host.apply).toHaveBeenCalledExactlyOnceWith('reviewed');
    expect((await automatic.read()).lastAttempt).toMatchObject({ state: 'accepted', jobId: 'accepted-job' });
    const stat = await fs.stat(path.join(directory, 'state/automatic-updates/settings.json'));
    expect(stat.mode & 0o077).toBe(0);
    vi.stubEnv('ORBIS_VERSION', 'v0.1.0-beta.92');
    automatic.onModuleDestroy();
    automatic = create();
    await automatic.onModuleInit();
    expect((await automatic.read()).lastAttempt?.state).toBe('complete');
    expect((await automatic.read()).settings.orbis.enabled).toBe(true);
  });

  it('blocks all clients and waits a full quiet period after the final browser disconnects', async () => {
    await automatic.update(settings());
    quiet();
    const first = activity.connect();
    const second = activity.connect();
    await automatic.tick();
    first();
    await automatic.tick();
    second();
    await automatic.tick();
    expect(releases.latest).not.toHaveBeenCalled();
    quiet();
    await automatic.tick();
    expect(host.apply).toHaveBeenCalledTimes(1);
  });

  it('defers if a browser arrives during planning and reuses the checked target after quiet returns', async () => {
    let resolvePlan!: (value: typeof plan) => void;
    host.plan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePlan = resolve;
        }),
    );
    await automatic.update(settings());
    quiet();
    const running = automatic.tick();
    await vi.waitFor(() => expect(host.plan).toHaveBeenCalledTimes(1));
    const disconnect = activity.connect();
    resolvePlan(plan);
    await running;
    expect(host.apply).not.toHaveBeenCalled();
    expect((await automatic.read()).lastAttempt?.state).toBe('deferred');
    disconnect();
    quiet();
    await automatic.tick();
    expect(host.apply).toHaveBeenCalledTimes(1);
    expect(releases.latest).toHaveBeenCalledTimes(1);
  });

  it('persists downgrade pause and prevents an already-planning automatic update from applying', async () => {
    let resolvePlan!: (value: typeof plan) => void;
    host.plan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePlan = resolve;
        }),
    );
    await automatic.update(settings());
    quiet();
    const running = automatic.tick();
    await vi.waitFor(() => expect(host.plan).toHaveBeenCalledTimes(1));
    await automatic.pauseForDowngrade();
    resolvePlan(plan);
    await running;
    expect(host.apply).not.toHaveBeenCalled();
    expect((await automatic.read()).settings.orbis.enabled).toBe(false);
    expect((await automatic.read()).pauseReason).toContain('downgrade');
    automatic.onModuleDestroy();
    automatic = create();
    await automatic.onModuleInit();
    expect((await automatic.read()).settings.orbis.enabled).toBe(false);
    await automatic.update(settings());
    expect((await automatic.read()).pauseReason).toBeNull();
  });

  it('does not overwrite a newer downgrade pause when an older automatic plan later fails', async () => {
    let rejectPlan!: (reason: Error) => void;
    host.plan.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPlan = reject;
        }),
    );
    await automatic.update(settings());
    quiet();
    const running = automatic.tick();
    await vi.waitFor(() => expect(host.plan).toHaveBeenCalledTimes(1));
    await automatic.pauseForDowngrade();
    rejectPlan(new Error('old plan failed'));
    await running;
    expect((await automatic.read()).settings.orbis.enabled).toBe(false);
    expect((await automatic.read()).pauseReason).toContain('downgrade');
    expect(host.apply).not.toHaveBeenCalled();
  });

  it('never replays an unconfirmed or failed apply, including after restart', async () => {
    host.apply.mockRejectedValue(new Error('timeout after dispatch'));
    await automatic.update(settings());
    quiet();
    await automatic.tick();
    expect((await automatic.read()).lastAttempt?.state).toBe('failed');
    expect((await automatic.read()).settings.orbis.enabled).toBe(false);
    quiet();
    await automatic.tick();
    automatic.onModuleDestroy();
    automatic = create();
    await automatic.onModuleInit();
    quiet();
    await automatic.tick();
    expect(host.apply).toHaveBeenCalledTimes(1);
  });

  it('requires manual review when the host plan cannot keep applications running', async () => {
    host.plan.mockResolvedValue({ ...plan, appsMustBeStopped: true });
    await automatic.update(settings());
    quiet();
    await automatic.tick();
    expect(host.apply).not.toHaveBeenCalled();
    expect((await automatic.read()).settings.orbis.enabled).toBe(false);
    expect((await automatic.read()).pauseReason).toContain('requires stopped applications');
    await automatic.tick();
    expect(host.plan).toHaveBeenCalledTimes(1);
  });

  it('keeps app updates manual on legacy settings and inherits an explicitly enabled default for later installations', async () => {
    await automatic.update(settings(false));
    expect((await automatic.readApp('adguard:tipi')).rule.mode).toBe('disabled');
    await automatic.update({ ...settings(false), apps: { enabled: true } });
    apps.getApps.mockResolvedValue([{ appName: 'adguard', appStoreSlug: 'tipi', status: 'running' }]);
    quiet();
    await automatic.tick();
    expect(lifecycle.updateApp).toHaveBeenCalledWith({ appUrn: 'adguard:tipi', performBackup: true });
    expect((await automatic.readApp('adguard:tipi')).rule.mode).toBe('global');
  });
  it('rejects a default above 256 Store apps without persisting invalid state, while custom apps do not consume admission slots', async () => {
    apps.getApps.mockResolvedValue(installedApps(257));
    await expect(automatic.update({ ...settings(false), apps: { enabled: true } })).rejects.toThrow('256');
    expect((await automatic.read()).available).toBe(true);
    expect((await automatic.read()).settings.apps?.enabled ?? false).toBe(false);
    apps.getApps.mockResolvedValue([...installedApps(256), { appName: 'local', appStoreSlug: '_user', status: 'running' }]);
    await automatic.update({ ...settings(false), apps: { enabled: true } });
    expect(automaticUpdateStateSchema.allows(await stored())).toBe(true);
    expect((await automatic.read()).settings.apps?.enabled).toBe(true);
    expect(lifecycle.updateApp).not.toHaveBeenCalled();
    expect((await stored()).appPauseReason).toBeUndefined();
  });
  it('pauses only the default when a future installation crosses the limit, retaining explicit choices and Orbis policy', async () => {
    await automatic.update({ ...settings(true, 'scheduled', '23:59'), apps: { enabled: true } });
    await automatic.updateApp('manual:tipi', { mode: 'disabled' });
    await automatic.updateApp('custom:tipi', { mode: 'custom', time: '23:59' });
    apps.getApps.mockResolvedValue(installedApps(257));
    quiet();
    await automatic.tick();
    const status = await automatic.read();
    expect(status.settings.apps?.enabled).toBe(false);
    expect(status.settings.orbis).toEqual({ enabled: true, mode: 'scheduled' });
    expect(status.appRules).toEqual({ 'manual:tipi': { mode: 'disabled' }, 'custom:tipi': { mode: 'custom', time: '23:59' } });
    expect(status.pauseReason).toContain('256');
    expect(status.available).toBe(true);
    expect(automaticUpdateStateSchema.allows(await stored())).toBe(true);
    expect(lifecycle.updateApp).not.toHaveBeenCalled();
  });
  it('prunes only target-free orphan checks during uninstall churn, preserving explicit and operation history', async () => {
    const history = Object.fromEntries(Array.from({ length: 250 }, (_, index) => [`orphan${index}:tipi`, attempt()]));
    history['orphan0:tipi'] = { ...attempt('failed'), jobId: 'unresolved-job' };
    history['orphan1:tipi'] = { ...attempt('failed'), targetTag: 'v0.1.0-beta.123' };
    history['lookup:tipi'] = attempt('failed');
    history['failed:tipi'] = attempt('failed', 2);
    history['accepted:tipi'] = { ...attempt('accepted', 2), jobId: 'accepted-job' };
    history['applying:tipi'] = attempt('applying', 2);
    history['manual:tipi'] = attempt();
    history['custom:tipi'] = attempt();
    await seedHistory(history, { 'manual:tipi': { mode: 'disabled' }, 'custom:tipi': { mode: 'custom', time: '23:59' } });
    apps.getApps.mockResolvedValue([{ appName: 'new', appStoreSlug: 'tipi', status: 'running' }]);
    quiet();
    await automatic.tick();
    const next = await stored();
    expect(Object.keys(next.apps).sort()).toEqual([
      'accepted:tipi',
      'applying:tipi',
      'custom:tipi',
      'failed:tipi',
      'manual:tipi',
      'new:tipi',
      'orphan0:tipi',
      'orphan1:tipi',
    ]);
    for (const urn of ['accepted:tipi', 'applying:tipi', 'failed:tipi', 'manual:tipi', 'custom:tipi', 'orphan0:tipi', 'orphan1:tipi'])
      expect(next.apps[urn]).toEqual(history[urn]);
    expect(next.settings.apps.enabled).toBe(true);
    expect(automaticUpdateStateSchema.allows(next)).toBe(true);
    expect(lifecycle.updateApp).toHaveBeenCalledExactlyOnceWith({ appUrn: 'new:tipi', performBackup: true });
  });
  it('retains a full protected journal and pauses the default rather than dropping history or writing entry 257', async () => {
    const history = Object.fromEntries(installedApps(256).map((_, index) => [`old${index}:tipi`, attempt('failed', 2)]));
    await seedHistory(history);
    apps.getApps.mockResolvedValue([{ appName: 'new', appStoreSlug: 'tipi', status: 'running' }]);
    quiet();
    await automatic.tick();
    expect((await stored()).apps).toEqual(history);
    expect((await automatic.read()).settings.apps?.enabled).toBe(false);
    expect((await automatic.read()).pauseReason).toContain('256');
    await expect(automatic.update({ ...settings(false), apps: { enabled: true } })).rejects.toThrow('256');
    expect(automaticUpdateStateSchema.allows(await stored())).toBe(true);
    expect(lifecycle.updateApp).not.toHaveBeenCalled();
    apps.getApps.mockResolvedValue([]);
    await automatic.update({ ...settings(false), apps: { enabled: true } });
    expect((await stored()).appPauseReason).toBeUndefined();
    expect((await automatic.read()).pauseReason).toBeNull();
    expect((await stored()).apps).toEqual(history);
  });
  it('does not replay an accepted target after an offline check, uninstall and reinstall', async () => {
    apps.getApps.mockResolvedValue([{ appName: 'adguard', appStoreSlug: 'tipi', status: 'running' }]);
    await automatic.update({ ...settings(false), apps: { enabled: true } });
    quiet();
    await automatic.tick();
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    marketplace.getAppUpdateInfo.mockResolvedValueOnce(null);
    await automatic.tick();
    expect((await automatic.readApp('adguard:tipi')).lastAttempt?.targetVersion).toBe(2);
    apps.getApps.mockResolvedValue([]);
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    await automatic.tick();
    apps.getApps.mockResolvedValue([{ appName: 'adguard', appStoreSlug: 'tipi', status: 'running' }]);
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    await automatic.tick();
    expect(lifecycle.updateApp).toHaveBeenCalledTimes(1);
    expect((await automatic.readApp('adguard:tipi')).lastAttempt?.state).toBe('accepted');
  });
  it('does not erase in-flight history when an operator changes that app to manual', async () => {
    let start: () => void = () => {};
    let finish: (value: { requestId: string }) => void = () => {};
    const started = new Promise<void>((done) => {
      start = done;
    });
    lifecycle.updateApp.mockImplementationOnce(() => {
      start();
      return new Promise((done) => {
        finish = done;
      });
    });
    await automatic.updateApp('adguard:tipi', { mode: 'global' });
    quiet();
    const checking = automatic.tick();
    await started;
    await automatic.updateApp('adguard:tipi', { mode: 'disabled' });
    expect((await automatic.readApp('adguard:tipi')).lastAttempt?.state).toBe('applying');
    finish({ requestId: 'accepted-after-manual' });
    await checking;
    expect((await automatic.readApp('adguard:tipi')).rule.mode).toBe('disabled');
    expect((await automatic.readApp('adguard:tipi')).lastAttempt?.state).toBe('accepted');
    await automatic.updateApp('adguard:tipi', { mode: 'global' });
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    await automatic.tick();
    expect(lifecycle.updateApp).toHaveBeenCalledTimes(1);
  });
  it('reports full history for an untracked explicit schedule before any marketplace request, without invalidating state', async () => {
    await seedHistory(
      Object.fromEntries(installedApps(256).map((_, index) => [`old${index}:tipi`, attempt('accepted', 2)])),
      { 'new:tipi': { mode: 'global' } },
      false,
    );
    apps.getApps.mockResolvedValue([{ appName: 'new', appStoreSlug: 'tipi', status: 'running' }]);
    quiet();
    await automatic.tick();
    await automatic.tick();
    expect(marketplace.getAppUpdateInfo).not.toHaveBeenCalled();
    expect(lifecycle.updateApp).not.toHaveBeenCalled();
    expect((await automatic.read()).pauseReason).toContain('256');
    expect((await automatic.read()).available).toBe(true);
    expect(automaticUpdateStateSchema.allows(await stored())).toBe(true);
  });
  it('preserves the existing Orbis pause explanation and the app warning across older settings payloads', async () => {
    await automatic.update({ ...settings(false), apps: { enabled: true } });
    await automatic.pauseForDowngrade();
    apps.getApps.mockResolvedValue(installedApps(257));
    quiet();
    await automatic.tick();
    expect((await automatic.read()).pauseReason).toContain('downgrade');
    expect((await automatic.read()).pauseReason).toContain('256');
    await automatic.update(settings(false));
    expect((await automatic.read()).pauseReason).toContain('downgrade');
    expect((await automatic.read()).pauseReason).toContain('256');
    expect((await automatic.read()).settings.apps?.enabled).toBe(false);
    expect((await stored()).appPauseReason).toBeUndefined();
    expect(JSON.parse(await fs.readFile(warningFile(), 'utf8'))).toEqual({ version: 1, reason: 'capacity' });
    expect((await fs.stat(warningFile())).mode & 0o777).toBe(0o600);
    automatic.onModuleDestroy();
    automatic = create();
    await automatic.onModuleInit();
    expect((await automatic.read()).pauseReason).toContain('256');
    await automatic.update(settings(false));
    expect((await automatic.read()).pauseReason).toContain('256');
    apps.getApps.mockResolvedValue([]);
    await automatic.update({ ...settings(false), apps: { enabled: true } });
    await expect(fs.stat(warningFile())).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await automatic.read()).pauseReason).toContain('downgrade');
    expect((await automatic.read()).pauseReason).not.toContain('256');
  });
  it('keeps the default off and history intact if warning persistence fails after the capacity pause', async () => {
    const history = { 'protected:tipi': attempt('accepted', 2) };
    await seedHistory(history);
    apps.getApps.mockResolvedValue(installedApps(257));
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination) === warningFile()) throw Object.assign(new Error('Fixture warning failure'), { code: 'EIO' });
      await rename(source, destination);
    });
    quiet();
    await automatic.tick();
    expect((await stored()).settings.apps.enabled).toBe(false);
    expect((await stored()).apps).toEqual(history);
    expect((await stored()).appPauseReason).toBeUndefined();
    expect((await automatic.read()).available).toBe(true);
    expect((await automatic.read()).pauseReason).toContain('256');
    expect(lifecycle.updateApp).not.toHaveBeenCalled();
  });
  it('does not enable the default when a warning cannot be cleared durably', async () => {
    await automatic.update({ ...settings(false), apps: { enabled: true } });
    apps.getApps.mockResolvedValue(installedApps(257));
    quiet();
    await automatic.tick();
    apps.getApps.mockResolvedValue([]);
    const unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
      if (String(file) === warningFile()) throw Object.assign(new Error('Fixture clear failure'), { code: 'EACCES' });
      await unlink(file);
    });
    await expect(automatic.update({ ...settings(false), apps: { enabled: true } })).rejects.toThrow('not changed');
    expect((await stored()).settings.apps.enabled).toBe(false);
    expect((await automatic.read()).pauseReason).toContain('256');
    expect(lifecycle.updateApp).not.toHaveBeenCalled();
  });
  it('refuses unknown or nonprivate sidecars without overwriting them or changing the settings format', async () => {
    await automatic.update(settings(false));
    for (const raw of [
      '{"version":2,"reason":"capacity"}',
      '{"version":1,"reason":"capacity","extra":true}',
      '{"version":1,"reason":"capacity","reason":"capacity"}',
      'x'.repeat(129),
    ]) {
      await fs.writeFile(warningFile(), raw, { mode: 0o600 });
      automatic.onModuleDestroy();
      automatic = create();
      await automatic.onModuleInit();
      await expect(automatic.update({ ...settings(false), apps: { enabled: true } })).rejects.toThrow('not changed');
      expect(await fs.readFile(warningFile(), 'utf8')).toBe(raw);
      expect((await stored()).settings.apps?.enabled ?? false).toBe(false);
    }
    await fs.writeFile(warningFile(), '{"version":1,"reason":"capacity"}');
    await fs.chmod(warningFile(), 0o644);
    await expect(automatic.update({ ...settings(false), apps: { enabled: true } })).rejects.toThrow('not changed');
    expect((await stored()).appPauseReason).toBeUndefined();
  });
  it('rejects a cluster rule overflow before persistence without disabling all automatic updates as a storage failure', async () => {
    const rules = Object.fromEntries(installedApps(256).map((_, index) => [`old${index}:tipi`, { mode: 'disabled' }]));
    await seedHistory({}, rules, false);
    apps.getApps.mockResolvedValue([{ appName: 'new', appStoreSlug: 'tipi', status: 'running' }]);
    const previous = await automatic.clusterSnapshot();
    await expect(
      automatic.applyClusterSettings({ 'app-updates': [{ urn: 'new:tipi', enabled: true }] }, { 'app-updates': syncHash(previous['app-updates']) }),
    ).rejects.toThrow('needs review');
    expect((await stored()).rules).toEqual(rules);
    expect((await automatic.read()).available).toBe(true);
    expect(automaticUpdateStateSchema.allows(await stored())).toBe(true);
  });

  it('preserves a manual app override through default changes, legacy saves and a server restart', async () => {
    await automatic.updateApp('adguard:tipi', { mode: 'disabled' });
    await automatic.update({ ...settings(false), apps: { enabled: true } });
    await automatic.update(settings(false, 'scheduled', '02:00'));
    expect((await automatic.read()).settings.apps?.enabled).toBe(true);
    automatic.onModuleDestroy();
    automatic = create();
    await automatic.onModuleInit();
    apps.getApps.mockResolvedValue([{ appName: 'adguard', appStoreSlug: 'tipi', status: 'running' }]);
    quiet();
    await automatic.tick();
    expect(lifecycle.updateApp).not.toHaveBeenCalled();
    expect((await automatic.readApp('adguard:tipi')).rule.mode).toBe('disabled');
    expect((await automatic.readApp('compose:_user')).rule.mode).toBe('disabled');
  });

  it('retains an explicitly synced manual app policy when the shared default is enabled later', async () => {
    apps.getApps.mockResolvedValue([{ appName: 'adguard', appStoreSlug: 'tipi', status: 'running' }]);
    const before = await automatic.clusterSnapshot();
    await automatic.applyClusterSettings(
      { 'app-updates': [{ urn: 'adguard:tipi', enabled: false }] },
      { 'app-updates': syncHash(before['app-updates']) },
    );
    await automatic.update({ ...settings(false), apps: { enabled: true } });
    expect((await automatic.readApp('adguard:tipi')).rule.mode).toBe('disabled');
    quiet();
    await automatic.tick();
    expect(lifecycle.updateApp).not.toHaveBeenCalled();
  });

  it('backs off read-only release failures until the next local day and does not offer downgrades', async () => {
    releases.latest.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ tag: 'v0.1.0-beta.90', imageManifestUrl: 'present' });
    await automatic.update(settings());
    quiet();
    await automatic.tick();
    await automatic.tick();
    expect(releases.latest).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    await automatic.tick();
    expect(releases.latest).toHaveBeenCalledTimes(2);
    expect(host.plan).not.toHaveBeenCalled();
    expect((await automatic.read()).lastAttempt?.state).toBe('no-update');
  });

  it('waits for custom global time and blocks busy or failed host jobs', async () => {
    await automatic.update(settings(true, 'scheduled', '04:00'));
    quiet();
    await automatic.tick();
    expect(host.status).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-10-24T04:00:00Z'));
    host.status.mockResolvedValueOnce({ ...healthy, job: { state: 'failed' } });
    await automatic.tick();
    expect(releases.latest).not.toHaveBeenCalled();
    await automatic.tick();
    expect(host.apply).toHaveBeenCalledTimes(1);
  });

  it('updates only explicitly opted-in apps with a backup and never replays the same failed or accepted target version', async () => {
    await automatic.updateApp('adguard:tipi', { mode: 'global' });
    quiet();
    await automatic.tick();
    expect(lifecycle.updateApp).toHaveBeenCalledExactlyOnceWith({ appUrn: 'adguard:tipi', performBackup: true });
    expect(releases.latest).not.toHaveBeenCalled();
    expect((await automatic.readApp('crafty:tipi')).rule.mode).toBe('disabled');
    vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
    await automatic.tick();
    expect(lifecycle.updateApp).toHaveBeenCalledTimes(1);
    await automatic.tick();
    expect(marketplace.getAppUpdateInfo).toHaveBeenCalledTimes(2);
    expect((await automatic.readApp('adguard:tipi')).lastAttempt).toMatchObject({ state: 'accepted', targetVersion: 2 });
  });

  it('respects ignored versions, transitional states and custom app time, and always lets an unavailable app be disabled', async () => {
    await automatic.updateApp('adguard:tipi', { mode: 'custom', time: '05:00' });
    quiet();
    await automatic.tick();
    expect(marketplace.getAppUpdateInfo).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-10-24T05:00:00Z'));
    apps.getAppByUrn.mockResolvedValue({ version: 1, ignoredVersion: 2, status: 'running' });
    await automatic.tick();
    expect(lifecycle.updateApp).not.toHaveBeenCalled();
    apps.getApps.mockResolvedValue([{ status: 'updating' }]);
    expect((await automatic.updateApp('adguard:tipi', { mode: 'disabled' })).rule.mode).toBe('disabled');
    expect(vi.getTimerCount()).toBe(0);
    apps.getAppByUrn.mockResolvedValue(undefined);
    expect((await automatic.updateApp('removed:tipi', { mode: 'disabled' })).rule.mode).toBe('disabled');
    expect((await automatic.readApp('removed:tipi')).available).toBe(false);
  });

  it('rejects malformed settings, unexpected options, unsupported apps and unsafe persisted state without enabling automation', async () => {
    for (const value of [
      { ...settings(), command: 'unsafe' },
      settings(true, 'idle', '25:00'),
      { ...settings(), schedule: { time: '03:00', timezone: 'UTC', unexpected: true } },
    ])
      await expect(automatic.update(value)).rejects.toThrow();
    await expect(automatic.updateApp('adguard:tipi', { mode: 'custom' })).rejects.toThrow();
    await expect(automatic.updateApp('manual:_user', { mode: 'global' })).rejects.toThrow();
    expect((await automatic.updateApp('manual:_user', { mode: 'disabled' })).available).toBe(false);
    automatic.onModuleDestroy();
    await fs.chmod(path.join(directory, 'state/automatic-updates/settings.json'), 0o644);
    automatic = create();
    await automatic.onModuleInit();
    quiet();
    await automatic.tick();
    expect((await automatic.read()).available).toBe(false);
    expect(releases.latest).not.toHaveBeenCalled();
    expect(lifecycle.updateApp).not.toHaveBeenCalled();
  });

  it('persists independent Core time while legacy app-time saves, rules and restart retain their own intent', async () => {
    await automatic.updateApp('manual:tipi', { mode: 'disabled' });
    await automatic.updateApp('custom:tipi', { mode: 'custom', time: '06:00' });
    await automatic.update({ ...settings(true, 'scheduled', '04:00'), orbisSchedule: { time: '03:00' } });
    const revision = (await automatic.read()).revision;
    await automatic.update({ ...settings(true, 'scheduled', '07:00'), expectedRevision: revision });
    expect(await automatic.read()).toMatchObject({
      capabilities: ['independent-schedules.v1'],
      orbisSchedule: { time: '03:00' },
      settings: { schedule: { time: '07:00' } },
    });
    const raw = await stored();
    expect(raw.settings.orbis.enabled).toBe(false);
    expect(automaticUpdateStateSchema.allows(raw)).toBe(true);
    expect(raw.rules).toEqual({ 'manual:tipi': { mode: 'disabled' }, 'custom:tipi': { mode: 'custom', time: '06:00' } });
    automatic.onModuleDestroy();
    automatic = create();
    await automatic.onModuleInit();
    expect(await automatic.read()).toMatchObject({
      settings: { orbis: { enabled: true }, schedule: { time: '07:00' } },
      orbisSchedule: { time: '03:00' },
    });
    await expect(automatic.update({ ...settings(false), expectedRevision: revision })).rejects.toThrow('settings changed');
  });
  it('migrates a legacy enabled Core schedule once, then leaves strict legacy readers OFF', async () => {
    const folder = path.join(directory, 'state', 'automatic-updates');
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(folder, 'settings.json'),
      JSON.stringify({
        version: 1,
        revision: 4,
        settings: settings(true, 'scheduled', '05:00'),
        rules: {},
        apps: {},
        orbis: null,
        pauseReason: null,
      }),
      { mode: 0o600 },
    );
    automatic.onModuleDestroy();
    automatic = create();
    await automatic.onModuleInit();
    expect(await automatic.read()).toMatchObject({ settings: { orbis: { enabled: true } }, orbisSchedule: { time: '05:00' } });
    expect((await stored()).settings.orbis.enabled).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(folder, 'system.json'), 'utf8')).enabled).toBe(false);
    expect(host.apply).not.toHaveBeenCalled();
  });
  it('a partial consent write cannot enable a legacy reader or lose retained app attempts', async () => {
    await seedHistory({ 'retained:tipi': attempt('accepted', 2) }, {}, false);
    const before = await stored();
    const rename = fs.rename;
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (String(target).endsWith('/schedule-policy.json')) throw new Error('Controlled policy write failure');
      return rename(source, target);
    });
    await expect(automatic.update({ ...settings(true, 'scheduled', '04:00'), orbisSchedule: { time: '03:00' } })).rejects.toThrow('saved safely');
    failure.mockRestore();
    expect((await stored()).settings.orbis.enabled).toBe(false);
    expect((await stored()).apps).toEqual(before.apps);
    automatic.onModuleDestroy();
    automatic = create();
    await automatic.onModuleInit();
    quiet();
    await automatic.tick();
    expect((await automatic.read()).settings.orbis.enabled).toBe(false);
    expect(host.apply).not.toHaveBeenCalled();
    expect((await stored()).apps).toEqual(before.apps);
  });
  it('legacy config changes invalidate independent consent and require explicit re-enable', async () => {
    await automatic.update({ ...settings(true, 'scheduled', '04:00'), orbisSchedule: { time: '02:00' } });
    const raw = await stored();
    raw.revision++;
    raw.settings.schedule.time = '07:00';
    await fs.writeFile(path.join(directory, 'state/automatic-updates/settings.json'), JSON.stringify(raw));
    automatic.onModuleDestroy();
    automatic = create();
    await automatic.onModuleInit();
    const read = await automatic.read();
    expect(read.settings.orbis.enabled).toBe(false);
    expect(read.pauseReason).toContain('outside this schedule');
    expect(read.orbisSchedule.time).toBe('02:00');
    await automatic.update({ ...read.settings, orbis: { ...read.settings.orbis, enabled: true }, expectedRevision: read.revision });
    expect((await automatic.read()).settings.orbis.enabled).toBe(true);
  });
  it('future independent-policy schema stays untouched and never falls back to a shared-time enabled grant', async () => {
    await automatic.update(settings(true));
    const file = path.join(directory, 'state/automatic-updates/schedule-policy.json');
    const raw = '{"version":2}';
    await fs.writeFile(file, raw);
    automatic.onModuleDestroy();
    automatic = create();
    await automatic.onModuleInit();
    quiet();
    await automatic.tick();
    expect((await automatic.read()).available).toBe(false);
    expect((await automatic.readSystem()).settings.enabled).toBe(false);
    expect(host.apply).not.toHaveBeenCalled();
    expect(await fs.readFile(file, 'utf8')).toBe(raw);
  });

  it('an error after publishing the enabled policy leaves a durable pending guard and stays paused on restart', async () => {
    await automatic.update(settings(false));
    const rename = fs.rename;
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      await rename(source, target);
      if (String(target).endsWith('/schedule-policy.json')) throw new Error('Controlled error after policy rename');
    });
    await expect(automatic.update({ ...settings(true, 'scheduled', '04:00'), orbisSchedule: { time: '03:00' } })).rejects.toThrow('saved safely');
    failure.mockRestore();
    const folder = path.join(directory, 'state/automatic-updates');
    expect(JSON.parse(await fs.readFile(path.join(folder, 'schedule-policy.json'), 'utf8')).orbis.enabled).toBe(true);
    expect((await fs.stat(path.join(folder, 'schedule-policy.json.pending'))).mode & 0o077).toBe(0);
    expect((await stored()).settings.orbis.enabled).toBe(false);
    automatic.onModuleDestroy();
    automatic = create();
    await automatic.onModuleInit();
    quiet();
    await automatic.tick();
    expect((await automatic.read()).available).toBe(false);
    expect((await automatic.read()).settings.orbis.enabled).toBe(false);
    expect(host.apply).not.toHaveBeenCalled();
  });
});

it('uses timezone-local daily slots across DST repeats and rejects invalid schedule options', () => {
  const schedule = { time: '01:30', timezone: 'America/New_York' };
  const first = dailyUpdateSlot(schedule, Date.parse('2026-11-01T05:45:00Z'));
  const repeated = dailyUpdateSlot(schedule, Date.parse('2026-11-01T06:45:00Z'));
  expect(first).toEqual(repeated);
  expect(first.due).toBe(true);
  expect(dailyUpdateSlot({ time: '03:00', timezone: 'Asia/Singapore' }, Date.parse('2026-10-24T19:00:00Z')).key).toBe(
    '2026-10-25/03:00/Asia/Singapore',
  );
  expect(() =>
    parseAutomaticSettings({ orbis: { enabled: true, mode: 'idle' }, schedule: { time: '03:00', timezone: 'UTC' }, extra: true }),
  ).toThrow();
  expect(() => parseAppUpdateRule({ mode: 'disabled', time: '03:00' })).toThrow();
});
