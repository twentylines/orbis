import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitoringActivityService } from '@/core/monitoring/monitoring-activity.service';
import { AutomaticUpdatesService } from './automatic-updates.service';

const refreshId = '00000000-0000-4000-8000-000000000001';
const installId = '00000000-0000-4000-8000-000000000002';
const candidate = {
  name: 'orbis-proof:arm64',
  installedVersion: '1',
  candidateVersion: '2',
  downloadBytes: 500,
  security: false,
  sources: [{ origin: 'QA', archive: 'stable', site: 'localhost', trusted: true }],
};
const inventory = { available: true, manager: 'apt', packageCount: 1, packages: [candidate] };
const healthy = {
  available: true,
  enrolled: true,
  imageMatches: true,
  coreState: 'running',
  coreHealth: 'healthy',
  currentTag: 'v0.1.0-beta.98',
  capabilities: ['packages.refresh.v1'],
  job: null,
};
const globalSettings = { orbis: { enabled: false, mode: 'idle' }, schedule: { time: '03:00', timezone: 'UTC' } };

describe('opt-in scheduled system updates', () => {
  let directory: string;
  let automatic: AutomaticUpdatesService;
  let activity: MonitoringActivityService;
  const host = { status: vi.fn(), packages: vi.fn(), packageJob: vi.fn(), packageRefresh: vi.fn(), packagePlan: vi.fn(), packageApply: vi.fn() };
  const config = { get: vi.fn() };
  const apps = { getApps: vi.fn() };
  const releases = { latest: vi.fn() };
  const channels = { read: vi.fn(async () => ({ version: 1 as const, channel: 'nightly' as const, revision: 'initial' })) };
  const lifecycle = { updateApp: vi.fn() };
  const create = () =>
    new AutomaticUpdatesService(
      config as never,
      host as never,
      releases as never,
      activity,
      apps as never,
      {} as never,
      lifecycle as never,
      { warn: vi.fn() } as never,
      channels as never,
    );
  const file = (name = 'system.json') => path.join(directory, 'state/automatic-updates', name);
  const ready = async () => {
    await automatic.updateSystem({ enabled: true });
    vi.setSystemTime(Date.now() + 11 * 60_000);
  };
  const reload = async () => {
    automatic.onModuleDestroy();
    automatic = create();
    await automatic.onModuleInit();
    vi.setSystemTime(Date.now() + 11 * 60_000);
  };
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T03:05:00Z'));
    vi.stubEnv('ORBIS_VERSION', healthy.currentTag);
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-system-schedule-'));
    config.get
      .mockReset()
      .mockImplementation((key: string) => (key === 'directories' ? { dataDir: directory } : key === 'userSettings' ? { timeZone: 'UTC' } : false));
    for (const fn of Object.values(host)) fn.mockReset();
    host.status.mockResolvedValue(healthy);
    host.packages.mockResolvedValue(inventory);
    host.packageRefresh.mockResolvedValue({ jobId: refreshId, state: 'queued' });
    host.packageJob.mockResolvedValue({ available: true, job: { id: refreshId, kind: 'refresh', state: 'complete' } });
    host.packagePlan.mockResolvedValue({ planId: installId, selected: [candidate], operations: [{ ...candidate, action: 'upgrade' }] });
    host.packageApply.mockResolvedValue({ jobId: installId, state: 'queued' });
    apps.getApps.mockReset().mockResolvedValue([]);
    releases.latest.mockReset();
    lifecycle.updateApp.mockReset();
    activity = new MonitoringActivityService();
    automatic = create();
    await automatic.onModuleInit();
  });
  afterEach(async () => {
    automatic.onModuleDestroy();
    activity.onModuleDestroy();
    await fs.rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('reads the disabled default without a timer, host probe or settings file', async () => {
    expect(await automatic.readSystem()).toMatchObject({ settings: { enabled: false }, shared: globalSettings.schedule });
    await automatic.tick();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.status).not.toHaveBeenCalled();
    await expect(fs.stat(file())).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('starts the existing timer with system-only opt-in and completes one refresh then one pinned installation', async () => {
    await ready();
    expect(vi.getTimerCount()).toBe(1);
    await Promise.all(Array.from({ length: 5 }, () => automatic.tick()));
    expect(host.packageRefresh).toHaveBeenCalledTimes(1);
    expect(host.packageApply).not.toHaveBeenCalled();
    await automatic.tick();
    expect(host.packagePlan).toHaveBeenCalledExactlyOnceWith([candidate.name]);
    expect(host.packageApply).toHaveBeenCalledExactlyOnceWith(installId);
    host.packageJob.mockResolvedValue({ job: { id: installId, state: 'complete', rebootRequired: true } });
    await automatic.tick();
    await automatic.tick();
    expect((await automatic.readSystem()).lastAttempt).toMatchObject({ state: 'complete', message: expect.stringContaining('manually') });
    expect(host.packageRefresh).toHaveBeenCalledTimes(1);
    expect(host.packageApply).toHaveBeenCalledTimes(1);
    expect(releases.latest).not.toHaveBeenCalled();
    expect(lifecycle.updateApp).not.toHaveBeenCalled();
  });
  it('uses the shared scheduled time while browsers are active, rather than Orbis-only idle scheduling', async () => {
    await automatic.update({ ...globalSettings, schedule: { time: '05:00', timezone: 'UTC' } });
    await ready();
    const disconnect = activity.connect();
    await automatic.tick();
    expect(host.packageRefresh).not.toHaveBeenCalled();
    vi.setSystemTime(new Date('2026-10-25T05:01:00Z'));
    await automatic.tick();
    expect(host.packageRefresh).toHaveBeenCalledTimes(1);
    disconnect();
  });
  it.each(['queued', 'running'])('waits for the exact refresh job while it is %s', async (state) => {
    await ready();
    await automatic.tick();
    host.packageJob.mockResolvedValue({ job: { id: refreshId, kind: 'refresh', state } });
    await automatic.tick();
    expect(host.packagePlan).not.toHaveBeenCalled();
    expect(host.packageRefresh).toHaveBeenCalledTimes(1);
  });
  it.each([
    null,
    { id: installId, kind: 'refresh', state: 'complete' },
    { id: refreshId, kind: 'refresh', state: 'failed' },
    { id: refreshId, kind: 'refresh', state: 'interrupted' },
    { id: refreshId, state: 'complete' },
  ])('pauses on missing, replaced, failed or wrong-kind job %j', async (job) => {
    await ready();
    await automatic.tick();
    host.packageJob.mockResolvedValue({ job });
    await automatic.tick();
    expect((await automatic.readSystem()).settings.enabled).toBe(false);
    expect(host.packageApply).not.toHaveBeenCalled();
  });
  it('does not adopt an unrelated job after an unconfirmed refresh dispatch, including after restart', async () => {
    host.packageRefresh.mockRejectedValue(new Error('lost response'));
    await ready();
    await automatic.tick();
    await reload();
    await automatic.tick();
    expect(host.packageRefresh).toHaveBeenCalledTimes(1);
    expect((await automatic.readSystem()).lastAttempt?.state).toBe('interrupted');
    expect(host.packagePlan).not.toHaveBeenCalled();
  });
  it('resumes observation of an accepted refresh across process restart, without dispatching it again', async () => {
    await ready();
    await automatic.tick();
    await reload();
    await automatic.tick();
    expect(host.packageRefresh).toHaveBeenCalledTimes(1);
    expect(host.packageApply).toHaveBeenCalledTimes(1);
  });
  it.each(['refresh', 'install'])('keeps only job observation alive when disabled during accepted %s', async (phase) => {
    await ready();
    await automatic.tick();
    if (phase === 'install') await automatic.tick();
    await automatic.updateSystem({ enabled: false });
    expect(vi.getTimerCount()).toBe(1);
    host.packageJob.mockResolvedValue({
      job: phase === 'install' ? { id: installId, state: 'complete', rebootRequired: true } : { id: refreshId, kind: 'refresh', state: 'complete' },
    });
    await automatic.tick();
    expect((await automatic.readSystem()).lastAttempt?.state).toBe('complete');
    expect(host.packageApply).toHaveBeenCalledTimes(phase === 'install' ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not adopt an installation response with a different job ID', async () => {
    await ready();
    await automatic.tick();
    host.packageApply.mockResolvedValue({ jobId: refreshId, state: 'queued' });
    await automatic.tick();
    expect((await automatic.readSystem()).lastAttempt?.state).toBe('interrupted');
    expect((await automatic.readSystem()).settings.enabled).toBe(false);
  });
  it('pauses an interrupted write-before-dispatch state instead of replaying it', async () => {
    await ready();
    await automatic.tick();
    const stored = JSON.parse(await fs.readFile(file(), 'utf8'));
    stored.attempt.state = 'applying';
    delete stored.attempt.jobId;
    await fs.writeFile(file(), JSON.stringify(stored), { mode: 0o600 });
    await reload();
    await automatic.tick();
    expect((await automatic.readSystem()).settings.enabled).toBe(false);
    expect(host.packageRefresh).toHaveBeenCalledTimes(1);
    expect(host.packageApply).not.toHaveBeenCalled();
  });
  it.each(['disable', 'shared-time', 'downgrade'])('prevents apply when %s changes while a plan is being prepared', async (change) => {
    await ready();
    await automatic.tick();
    let resolve!: (v: unknown) => void;
    host.packagePlan.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const tick = automatic.tick();
    await vi.waitFor(() => expect(host.packagePlan).toHaveBeenCalledTimes(1));
    if (change === 'disable') await automatic.updateSystem({ enabled: false });
    if (change === 'shared-time') await automatic.update({ ...globalSettings, schedule: { time: '23:00', timezone: 'UTC' } });
    if (change === 'downgrade') await automatic.pauseForDowngrade();
    resolve({ planId: installId, selected: [candidate], operations: [{ ...candidate, action: 'upgrade' }] });
    await tick;
    expect(host.packageApply).not.toHaveBeenCalled();
  });
  it('a later disable invalidates an older enable request still checking the helper', async () => {
    let resolve!: (v: unknown) => void;
    host.status.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const enabling = automatic.updateSystem({ enabled: true });
    await vi.waitFor(() => expect(host.status).toHaveBeenCalledTimes(1));
    await automatic.updateSystem({ enabled: false });
    resolve(healthy);
    await expect(enabling).rejects.toThrow('settings changed');
    expect((await automatic.readSystem()).settings.enabled).toBe(false);
  });
  it('a downgrade pause invalidates an enable that started while system updates were still off', async () => {
    let resolve!: (v: unknown) => void;
    host.status.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const enabling = automatic.updateSystem({ enabled: true });
    await vi.waitFor(() => expect(host.status).toHaveBeenCalledTimes(1));
    await automatic.pauseForDowngrade();
    resolve(healthy);
    await expect(enabling).rejects.toThrow('settings changed');
    expect((await automatic.readSystem()).settings.enabled).toBe(false);
  });
  it('never installs after an empty refreshed inventory', async () => {
    await ready();
    await automatic.tick();
    host.packages.mockResolvedValue({ ...inventory, packageCount: 0, packages: [] });
    await automatic.tick();
    expect((await automatic.readSystem()).lastAttempt?.state).toBe('no-update');
    expect(host.packagePlan).not.toHaveBeenCalled();
  });
  it.each([
    { ...inventory, truncated: true },
    { ...inventory, packageCount: 251, packages: Array(251).fill(candidate) },
    { ...inventory, packageCount: 2, packages: [candidate, candidate] },
    { ...inventory, packages: [{ ...candidate, sources: [{ trusted: false }] }] },
  ])('requires manual review for unsafe or oversized inventory', async (value) => {
    await ready();
    await automatic.tick();
    host.packages.mockResolvedValue(value);
    await automatic.tick();
    expect(host.packageApply).not.toHaveBeenCalled();
    expect((await automatic.readSystem()).settings.enabled).toBe(false);
  });
  it('rejects changed candidates or more than250 simulated operations', async () => {
    await ready();
    await automatic.tick();
    host.packagePlan.mockResolvedValue({ planId: installId, selected: [candidate], operations: Array(251).fill({ action: 'upgrade' }) });
    await automatic.tick();
    expect(host.packageApply).not.toHaveBeenCalled();
  });
  it('does not change the legacy core/app state format and isolates a corrupt system policy', async () => {
    await automatic.update(globalSettings);
    const original = await fs.readFile(file('settings.json'), 'utf8');
    await ready();
    expect(await fs.readFile(file('settings.json'), 'utf8')).toBe(original);
    expect((await fs.stat(file())).mode & 0o077).toBe(0);
    await fs.writeFile(file(), '{broken');
    await reload();
    expect((await automatic.readSystem()).available).toBe(false);
    expect((await automatic.read()).available).toBe(true);
  });
  it('does not run a valid system policy with an unreadable shared schedule', async () => {
    await ready();
    await fs.writeFile(file('settings.json'), '{broken', { mode: 0o600 });
    await reload();
    await automatic.tick();
    expect((await automatic.readSystem()).available).toBe(false);
    expect(host.packageRefresh).not.toHaveBeenCalled();
  });
  it('allows disabling with an older or missing helper but rejects enabling it', async () => {
    await ready();
    host.status.mockResolvedValue({ available: false });
    await automatic.updateSystem({ enabled: false });
    await expect(automatic.updateSystem({ enabled: true })).rejects.toThrow('host service');
    expect((await automatic.readSystem()).settings.enabled).toBe(false);
  });
});
