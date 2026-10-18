import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import type { HostDisk, HostNetwork, HostTelemetry, MetricHistoryRange } from '@runtipi/common/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { HostTelemetryService } from '../host-telemetry.service';
import { HostDeviceHistoryService } from '../host-device-history.service';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { fsMock } = await import('../../../tests/__mocks__/fs');
  return { ...fsMock, constants: actual.constants, createReadStream: actual.createReadStream };
});

const origin = Date.parse('2026-10-18T00:00:00.000Z');
const firstSource = 'a'.repeat(64);
const nextSource = 'b'.repeat(64);
const selected = { kind: 'network', name: 'eth0' } as const;
const network = (overrides: Partial<HostNetwork> = {}): HostNetwork => ({
  interface: 'eth0',
  historyId: firstSource,
  state: 'up',
  speedMbps: 1000,
  receivedBytes: 10000,
  transmittedBytes: 20000,
  rxBytesPerSecond: 100,
  txBytesPerSecond: 20,
  ...overrides,
});
const disk = (overrides: Partial<HostDisk> = {}): HostDisk => ({
  device: 'sda',
  historyId: firstSource,
  readBytes: 10000,
  writtenBytes: 20000,
  readBytesPerSecond: 500,
  writeBytesPerSecond: 50,
  busyPercent: 40,
  inFlight: 1,
  ...overrides,
});
const reading = (at = Date.now(), interfaces = [network()], disks = [disk()]): Extract<HostTelemetry, { available: true }> => ({
  available: true,
  sampledAt: new Date(at).toISOString(),
  stale: false,
  filesystems: [],
  network: interfaces,
  disks,
  omitted: { filesystems: 0, network: 0, disks: 0 },
  unavailable: [],
});

async function until(condition: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (await condition()) return;
    await pause(2);
  }
  throw new Error('History fixture did not settle');
}

async function fileHash(file: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('autonomous private host device history service', () => {
  const host = mock<HostTelemetryService>();
  const config = mock<ConfigurationService>();
  const logger = mock<LoggerService>();
  let directory: string;
  let service: HostDeviceHistoryService;
  let services: Set<HostDeviceHistoryService>;
  let releases: (() => void)[];
  const file = () => path.join(directory, 'state', 'orbis-host-history', 'devices-v1.jsonl');
  const create = () => {
    const result = new HostDeviceHistoryService(host, config, logger);
    services.add(result);
    return result;
  };
  const close = async (target = service) => {
    await target.onModuleDestroy();
    services.delete(target);
  };
  const collect = async (seconds: number, interfaces = [network()], disks = [disk()]) => {
    vi.setSystemTime(origin + seconds * 1000);
    host.read.mockResolvedValue(reading(Date.now(), interfaces, disks));
    await service.collect();
  };
  const privateJournal = async (contents: string) => {
    await fs.mkdir(path.dirname(file()), { recursive: true, mode: 0o700 });
    await fs.writeFile(file(), contents, { mode: 0o600 });
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(origin + 2000);
    host.read.mockReset();
    logger.warn.mockReset();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-host-history-service-'));
    config.get.calledWith('directories').mockReturnValue({ dataDir: directory } as never);
    services = new Set();
    releases = [];
    service = create();
  });
  afterEach(async () => {
    for (const release of releases) release();
    for (const instance of services) await instance.onModuleDestroy();
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('collects from one server timer without browser readers and stops cleanly', async () => {
    host.read.mockImplementation(async () => reading());
    await service.onModuleInit();
    await service.collect();
    await vi.advanceTimersByTimeAsync(30000);
    expect(host.read).toHaveBeenCalledTimes(4);
    const history = await service.read('5m', selected);
    expect(history.points).toHaveLength(4);
    expect(history.collectorAvailable).toBe(true);
    expect(history.points.map((point) => point.at)).toEqual([2, 12, 22, 32].map((seconds) => new Date(origin + seconds * 1000).toISOString()));
    await Promise.all(Array.from({ length: 20 }, () => service.read('1h', selected)));
    expect(host.read).toHaveBeenCalledTimes(4);
    await close();
    await vi.advanceTimersByTimeAsync(20000);
    await service.collect();
    expect(host.read).toHaveBeenCalledTimes(4);
  });

  it('coalesces concurrent collection and ignores repeated and backward cached samples', async () => {
    const gate = deferred<HostTelemetry>();
    releases.push(() => gate.resolve(reading(origin + 2000)));
    host.read.mockReturnValue(gate.promise);
    const first = service.collect();
    const second = service.collect();
    expect(first).toBe(second);
    await until(() => host.read.mock.calls.length === 1);
    gate.resolve(reading(origin + 2000));
    await Promise.all([first, second]);
    vi.setSystemTime(origin + 12000);
    for (const at of [origin + 2000, origin + 1000, origin + 3999]) {
      host.read.mockResolvedValue(reading(at));
      await service.collect();
    }
    expect((await service.read('5m', selected)).points).toHaveLength(1);
    expect((await service.read('1h', selected)).points[0]?.samples).toBe(1);
    await collect(22);
    expect((await service.read('5m', selected)).points).toHaveLength(2);
  });

  it('does not turn stale, old, future, unavailable or rejected samples into fresh points', async () => {
    await collect(2);
    vi.setSystemTime(origin + 12000);
    const bad: HostTelemetry[] = [
      { ...reading(), stale: true } as HostTelemetry,
      reading(Date.now() - 30001),
      reading(Date.now() + 5001),
      { available: false, reason: 'Host service is unavailable.' },
    ];
    for (const value of bad) {
      host.read.mockResolvedValue(value);
      await service.collect();
      expect(await service.read('1h', selected)).toMatchObject({
        collectorAvailable: false,
        lastSampleAt: new Date(origin + 2000).toISOString(),
        points: [{ samples: 1 }],
      });
    }
    host.read.mockRejectedValue(new Error('private simulated host fault'));
    await service.collect();
    expect(await service.read('5m', selected)).toMatchObject({
      collectorAvailable: false,
      reason: 'Host device history collection is interrupted. Missing readings remain gaps.',
      points: [{ samples: 1 }],
    });
    await collect(22);
    vi.setSystemTime(origin + 52000);
    expect((await service.read('5m', selected)).collectorAvailable).toBe(false);
  });

  it('keeps measured weighted means, peaks and counts separate for every device and tier', async () => {
    for (const seconds of [2, 12, 22]) await collect(seconds, [network(), network({ interface: 'br0', rxBytesPerSecond: 1000 })]);
    await collect(62, [network({ rxBytesPerSecond: 900 }), network({ interface: 'br0', rxBytesPerSecond: 3000 })]);
    expect((await service.read('1h', selected)).points.map((point) => point.inbound)).toEqual([
      { average: 100, peak: 100, samples: 3 },
      { average: 900, peak: 900, samples: 1 },
    ]);
    for (const range of ['24h', '7d'] as const) {
      expect((await service.read(range, selected)).points[0]?.inbound).toEqual({ average: 300, peak: 900, samples: 4 });
      expect((await service.read(range, { kind: 'network', name: 'br0' })).points[0]?.inbound).toEqual({ average: 1500, peak: 3000, samples: 4 });
      expect((await service.read(range, { kind: 'disk', name: 'sda' })).points[0]?.inbound).toEqual({ average: 500, peak: 500, samples: 4 });
    }
    expect((await service.read('5m', selected)).points.map((point) => point.intervalSeconds)).toEqual([10, 10, 10, 10]);
  });

  it('keeps missing values null and invalidates only the device aggregate whose identity changes', async () => {
    await collect(2, [network({ rxBytesPerSecond: 10, txBytesPerSecond: null })], [disk({ readBytesPerSecond: 300, busyPercent: 20 })]);
    await collect(12, [network({ rxBytesPerSecond: null, txBytesPerSecond: 30 })], [disk({ readBytesPerSecond: null, busyPercent: 80 })]);
    await collect(22, [network({ rxBytesPerSecond: 70, txBytesPerSecond: 90 })], [disk({ readBytesPerSecond: 900, busyPercent: null })]);
    expect((await service.read('1h', selected)).points[0]).toMatchObject({
      samples: 3,
      inbound: { average: 40, peak: 70, samples: 2 },
      outbound: { average: 60, peak: 90, samples: 2 },
      busy: { average: null, peak: null, samples: 0 },
    });
    await collect(32, [network({ historyId: nextSource })]);
    expect((await service.read('1h', selected)).points[0]).toMatchObject({
      sourceId: null,
      samples: 4,
      inbound: { average: null, peak: null, samples: 0 },
    });
    expect((await service.read('1h', { kind: 'disk', name: 'sda' })).points[0]?.busy).toEqual({ average: 140 / 3, peak: 80, samples: 3 });
    expect((await service.read('5m', selected)).points.map((point) => point.sourceId)).toEqual([firstSource, firstSource, firstSource, nextSource]);
  });

  it('preserves a generation break between clean minute aggregates', async () => {
    await collect(2);
    await collect(62, [network({ historyId: nextSource })]);
    const history = await service.read('1h', selected);
    expect(history.points.map((point) => point.sourceId)).toEqual([firstSource, nextSource]);
    expect(history.points.map((point) => point.inbound.average)).toEqual([100, 100]);
  });

  it('reports old-helper capability honestly without adding unidentified rows as zero readings', async () => {
    await collect(2);
    vi.setSystemTime(origin + 12000);
    const value = reading(Date.now(), [network({ historyId: undefined })], []);
    if (!value.available) throw new Error('Expected available fixture');
    value.omitted = { filesystems: 0, network: 3, disks: 4 };
    host.read.mockResolvedValue(value);
    await service.collect();
    const history = await service.read('5m', selected);
    expect(history).toMatchObject({
      collectorAvailable: false,
      unidentifiedDevices: 1,
      omittedDevices: 7,
      points: [{ samples: 1, inbound: { average: 100, samples: 1 } }],
    });
    expect(history.reason).toMatch(/updated host service|readable kernel identity/);
    expect(history.devices.every((device) => !device.present)).toBe(true);
  });

  it('reports a failed interface group while retaining measured disk history', async () => {
    await collect(2);
    vi.setSystemTime(origin + 12000);
    host.read.mockResolvedValue({ ...reading(Date.now(), [], [disk()]), unavailable: ['network'] });
    await service.collect();
    const history = await service.read('5m', selected);
    expect(history.collectorAvailable).toBe(true);
    expect(history.reason).toContain('Host network readings are unavailable.');
    expect(history.devices.find((item) => item.kind === 'network')?.present).toBe(false);
    expect(history.points).toHaveLength(1);
    expect((await service.read('5m', { kind: 'disk', name: 'sda' })).points).toHaveLength(2);
  });

  it('does not report healthy collection when both history groups fail', async () => {
    host.read.mockResolvedValue({ ...reading(Date.now(), [], []), unavailable: ['network', 'disks'] });
    await service.collect();
    expect(await service.read('5m')).toMatchObject({
      collectorAvailable: false,
      reason: 'Host network and disk readings are unavailable.',
      points: [],
    });
  });

  it('keeps filesystem-only failures separate from disk and interface history', async () => {
    host.read.mockResolvedValue({ ...reading(), unavailable: ['filesystems'] });
    await service.collect();
    expect(await service.read('5m')).toMatchObject({ collectorAvailable: true, reason: null });
  });

  it('limits logical name churn to64, reports eviction and persists the bounded catalogue', async () => {
    const devices = Array.from({ length: 32 }, (_, index) => disk({ device: `disk${index}` }));
    await collect(
      2,
      Array.from({ length: 32 }, (_, index) => network({ interface: `old${index}` })),
      devices,
    );
    await collect(
      12,
      Array.from({ length: 32 }, (_, index) => network({ interface: `new${index}` })),
      devices,
    );
    const history = await service.read('7d', { kind: 'network', name: 'old0' });
    expect(history).toMatchObject({ seriesLimit: 64, evictedDevices: 32, points: [] });
    expect(history.devices).toHaveLength(64);
    expect(history.devices.every((device) => device.present && !device.name.startsWith('old'))).toBe(true);
    await close();
    service = create();
    expect(await service.read('7d', { kind: 'network', name: 'old0' })).toMatchObject({ evictedDevices: 32, points: [] });
    expect((await service.read('7d')).devices).toHaveLength(64);
  });

  it.each([
    ['5m', 300000],
    ['1h', 3600000],
    ['24h', 86400000],
    ['7d', 604800000],
  ] as [MetricHistoryRange, number][])('enforces the actual %s retention boundary', async (range, retention) => {
    await collect(2);
    vi.setSystemTime(origin + 2000 + retention);
    expect((await service.read(range, selected)).points).toHaveLength(1);
    vi.setSystemTime(origin + 2001 + retention);
    expect((await service.read(range, selected)).points).toHaveLength(0);
    expect((await service.read(range, selected)).evictedDevices).toBe(0);
  });

  it('does not write a complete archive on each sample and uses private600files/700directories', async () => {
    await collect(2);
    await collect(12);
    await collect(22);
    await expect(fs.stat(file())).rejects.toMatchObject({ code: 'ENOENT' });
    await close();
    expect((await fs.stat(file())).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file()))).mode & 0o777).toBe(0o700);
    const records = (await fs.readFile(file(), 'utf8')).trim().split('\n');
    expect(records).toHaveLength(3);
    service = create();
    expect((await service.read('1h', selected)).points[0]?.inbound).toEqual({ average: 100, peak: 100, samples: 3 });
    expect((await service.read('1h', selected)).collectorAvailable).toBe(false);
  });

  it('restores partial minutes through two restarts without double counting5m or coarse tiers', async () => {
    await collect(2, [network({ rxBytesPerSecond: 10 })]);
    await collect(12, [network({ rxBytesPerSecond: 40 })]);
    await collect(22, [network({ rxBytesPerSecond: null })]);
    await close();
    service = create();
    await collect(32, [network({ rxBytesPerSecond: 80 })]);
    const first = await service.read('5m', selected);
    expect(first.points.map((point) => point.samples)).toEqual([3, 1]);
    expect(first.points.map((point) => point.inbound.samples)).toEqual([2, 1]);
    expect((await service.read('1h', selected)).points[0]?.inbound.average).toBeCloseTo(130 / 3);
    await collect(62, [network({ rxBytesPerSecond: 20 })]);
    await close();
    service = create();
    await collect(72, [network({ rxBytesPerSecond: 100 })]);
    const recent = await service.read('5m', selected);
    expect(recent.points.map((point) => point.intervalSeconds)).toEqual([60, 60, 10]);
    expect(recent.points.reduce((sum, point) => sum + point.samples, 0)).toBe(6);
    expect(recent.points.reduce((sum, point) => sum + point.inbound.samples, 0)).toBe(5);
    expect((await service.read('24h', selected)).points[0]?.inbound).toEqual({ average: 50, peak: 100, samples: 5 });
  });

  it('preserves a corrupt journal byte-for-byte while retaining its valid prefix and new memory readings', async () => {
    await collect(2);
    await close();
    await fs.appendFile(file(), 'truncated-private-record\n');
    const original = await fs.readFile(file());
    service = create();
    await collect(12, [network({ rxBytesPerSecond: 300 })]);
    await close();
    expect(await fs.readFile(file())).toEqual(original);
    expect(await service.read('1h', selected)).toMatchObject({
      storage: 'unavailable',
      points: [{ samples: 2, inbound: { average: 200, peak: 300, samples: 2 } }],
    });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(await service.read('1h', selected))).not.toContain('truncated-private-record');
  });

  it('rejects a sparse oversized journal without reading/repairing it and continues collecting', async () => {
    await privateJournal('preserve-oversize-head');
    const handle = await fs.open(file(), 'r+');
    await handle.truncate(32 * 1024 * 1024 + 1);
    await handle.close();
    const original = await fileHash(file());
    await collect(2);
    await collect(62);
    await close();
    expect(await fileHash(file())).toBe(original);
    expect(await service.read('1h', selected)).toMatchObject({ storage: 'unavailable', points: [{ samples: 1 }, { samples: 1 }] });
  });

  it.each(['file-symlink', 'directory-symlink', 'unsafe-file-mode', 'unsafe-directory-mode'] as const)(
    'preserves %s targets and keeps collecting in memory',
    async (kind) => {
      const protectedDirectory = path.join(directory, 'protected');
      const target = path.join(protectedDirectory, 'devices-v1.jsonl');
      await fs.mkdir(protectedDirectory, { mode: 0o700 });
      await fs.writeFile(target, 'preserve-private-target', { mode: 0o600 });
      if (kind === 'directory-symlink') {
        await fs.mkdir(path.dirname(path.dirname(file())), { recursive: true });
        await fs.symlink(protectedDirectory, path.dirname(file()));
      } else {
        await fs.mkdir(path.dirname(file()), { recursive: true, mode: 0o700 });
        if (kind === 'file-symlink') await fs.symlink(target, file());
        else {
          await fs.copyFile(target, file());
          await fs.chmod(file(), kind === 'unsafe-file-mode' ? 0o644 : 0o600);
          if (kind === 'unsafe-directory-mode') await fs.chmod(path.dirname(file()), 0o755);
        }
      }
      const original = await fs.readFile(file());
      await collect(2);
      await collect(62);
      await close();
      expect(await fs.readFile(file())).toEqual(original);
      expect(await fs.readFile(target, 'utf8')).toBe('preserve-private-target');
      expect(await service.read('1h', selected)).toMatchObject({ storage: 'unavailable', points: [{ samples: 1 }, { samples: 1 }] });
      if (kind === 'file-symlink') expect((await fs.lstat(file())).isSymbolicLink()).toBe(true);
      if (kind === 'directory-symlink') expect((await fs.lstat(path.dirname(file()))).isSymbolicLink()).toBe(true);
    },
  );

  it('backs off failed storage until a bucket boundary without losing live in-memory history', async () => {
    await collect(2);
    await close();
    const original = await fs.readFile(file());
    service = create();
    await collect(12);
    const failure = Object.assign(new Error('private write fault'), { code: 'EACCES' });
    const mkdir = vi.spyOn(fs, 'mkdir').mockRejectedValue(failure);
    const cleanup = vi.spyOn(fs, 'rm');
    await collect(62);
    await until(async () => (await service.read('1h', selected)).storage === 'unavailable');
    await until(() => cleanup.mock.results.length === 1);
    await cleanup.mock.results[0]?.value;
    await Promise.resolve();
    expect(mkdir).toHaveBeenCalledOnce();
    for (const seconds of [72, 82, 92, 102, 112]) await collect(seconds);
    expect(mkdir).toHaveBeenCalledOnce();
    expect((await service.read('5m', selected)).points.length).toBeGreaterThan(5);
    await collect(122);
    await until(() => mkdir.mock.calls.length === 2);
    await close();
    expect(mkdir.mock.calls.length).toBeLessThanOrEqual(3);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(await fs.readFile(file())).toEqual(original);
    expect((await service.read('1h', selected)).collectorAvailable).toBe(true);
  });

  it('keeps one blocked writer and coalesces pending bucket updates under an hour of collection', async () => {
    await collect(2);
    const gate = deferred<void>();
    releases.push(() => gate.resolve());
    const realMkdir = fs.mkdir;
    const mkdir = vi.spyOn(fs, 'mkdir').mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
      await gate.promise;
      return realMkdir(...args);
    });
    for (let index = 1; index <= 6; index++) await collect(index * 10 + 2);
    await until(() => mkdir.mock.calls.length === 1);
    for (let index = 7; index <= 360; index++) await collect(index * 10 + 2);
    expect(mkdir).toHaveBeenCalledOnce();
    const live = await service.read('5m', selected);
    expect(live).toMatchObject({ collectorAvailable: true, storage: 'unavailable' });
    expect(live.points.length).toBeLessThanOrEqual(31);
    expect(live.points.at(-1)?.at).toBe(new Date(origin + 3602000).toISOString());
    const closing = close();
    gate.resolve();
    await closing;
    const lines = (await fs.readFile(file(), 'utf8')).trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(90);
    expect((await fs.stat(file())).size).toBeLessThan(1024 * 1024);
    expect((await service.read('1h', selected)).storage).toBe('persistent');
    service = create();
    expect((await service.read('1h', selected)).points.reduce((sum, point) => sum + point.samples, 0)).toBe(361);
  });
});
