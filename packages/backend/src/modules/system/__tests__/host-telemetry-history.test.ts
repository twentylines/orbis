import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HostTelemetry } from '@runtipi/common/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { HostDeviceHistoryService } from '../host-device-history.service';
import { MonitoringActivityService } from '@/core/monitoring/monitoring-activity.service';
import { readHostSocket } from '../host-socket';
import { HostTelemetryService } from '../host-telemetry.service';

vi.mock('../host-socket', () => ({ readHostSocket: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { fsMock } = await import('../../../tests/__mocks__/fs');
  return { ...fsMock, constants: actual.constants };
});

const origin = Date.parse('2026-10-18T00:00:00.000Z');
const selected = { kind: 'network', name: 'eth0' } as const;
const reading = (at = Date.now()): Extract<HostTelemetry, { available: true }> => ({
  available: true,
  sampledAt: new Date(at).toISOString(),
  stale: false,
  filesystems: [],
  network: [
    {
      interface: 'eth0',
      historyId: 'a'.repeat(64),
      state: 'up',
      speedMbps: 1000,
      receivedBytes: 1000,
      transmittedBytes: 2000,
      rxBytesPerSecond: 100,
      txBytesPerSecond: 20,
    },
  ],
  disks: [],
  omitted: { filesystems: 0, network: 0, disks: 0 },
  unavailable: [],
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('host cache timing with autonomous history', () => {
  const socket = vi.mocked(readHostSocket);
  let history: HostDeviceHistoryService | undefined;
  let directory: string;
  let releases: (() => void)[] = [];

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(origin + 20000);
    socket.mockReset();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-host-cache-history-'));
    releases = [];
  });

  afterEach(async () => {
    for (const release of releases) release();
    await history?.onModuleDestroy();
    history = undefined;
    vi.useRealTimers();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each([100, 9000])('keeps the real ten-second history timer fresh with %ims response latency and previous helper samples', async (latency) => {
    socket.mockImplementation(async (_socket, _endpoint, parse) => {
      const sample = reading(Date.now() - 10000);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
        setTimeout(resolve, latency);
      });
      return parse(sample);
    });
    const config = mock<ConfigurationService>();
    config.get.calledWith('directories').mockReturnValue({ dataDir: directory } as never);
    const telemetry = new HostTelemetryService();
    const activity = new MonitoringActivityService();
    activity.connect();
    history = new HostDeviceHistoryService(telemetry, config, mock<LoggerService>(), activity);

    await history.onModuleInit();
    await vi.advanceTimersByTimeAsync(130000);

    expect(socket).toHaveBeenCalledTimes(14);
    const result = await history.read('5m', selected);
    expect(result.collectorAvailable).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.points).toHaveLength(13);
    expect(result.points.map((point) => point.at)).toEqual(
      Array.from({ length: 13 }, (_, index) => new Date(origin + (index + 1) * 10000).toISOString()),
    );
    expect(result.points.every((point) => point.samples === 1 && point.inbound.samples === 1)).toBe(true);
    expect(result.lastSampleAt).toBe(new Date(origin + 130000).toISOString());
    expect(Date.now() - Date.parse(result.lastSampleAt ?? '')).toBe(20000);
  });

  it('expires successful readings nine seconds after request start while coalescing delayed readers', async () => {
    const firstGate = deferred<HostTelemetry>();
    const secondGate = deferred<HostTelemetry>();
    releases.push(
      () => firstGate.resolve(reading()),
      () => secondGate.resolve(reading()),
    );
    socket.mockImplementationOnce(async () => firstGate.promise).mockImplementationOnce(async () => secondGate.promise);
    const telemetry = new HostTelemetryService();
    const first = telemetry.read();
    expect(telemetry.read()).toBe(first);
    await vi.advanceTimersByTimeAsync(8999);
    expect(telemetry.read()).toBe(first);
    firstGate.resolve(reading(origin + 20000));
    const value = await first;
    expect(await telemetry.read()).toBe(value);
    expect(socket).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const refreshed = telemetry.read();
    expect(socket).toHaveBeenCalledTimes(2);
    expect(refreshed).not.toBe(first);
    expect(telemetry.read()).toBe(refreshed);
    secondGate.resolve(reading());
    await refreshed;
  });

  it.each(['unavailable', 'rejected'])('retains two seconds of unavailable backoff after a delayed %s response', async (kind) => {
    const gate = deferred<void>();
    releases.push(() => gate.resolve());
    socket.mockImplementationOnce(async () => {
      await gate.promise;
      if (kind === 'rejected') throw new Error('private helper failure');
      return { available: false, reason: 'Collecting host readings.' };
    });
    socket.mockResolvedValue(reading());
    const telemetry = new HostTelemetryService();
    const pending = telemetry.read();
    await vi.advanceTimersByTimeAsync(9000);
    gate.resolve();
    const unavailable = await pending;
    expect(unavailable.available).toBe(false);
    await vi.advanceTimersByTimeAsync(1999);
    expect(await telemetry.read()).toBe(unavailable);
    expect(socket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await telemetry.read()).toHaveProperty('available', true);
    expect(socket).toHaveBeenCalledTimes(2);
  });
});
