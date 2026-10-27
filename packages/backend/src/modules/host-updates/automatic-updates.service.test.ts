import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomaticUpdatesService } from './automatic-updates.service';
import { MonitoringActivityService } from '@/core/monitoring/monitoring-activity.service';
import { dailyUpdateSlot, parseAppUpdateRule, parseAutomaticSettings } from './automatic-updates.model';

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

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T03:20:00Z'));
    vi.stubEnv('ORBIS_VERSION', 'v0.1.0-beta.91');
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-automatic-test-'));
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
