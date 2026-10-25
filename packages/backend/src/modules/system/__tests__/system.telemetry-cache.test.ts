import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemService } from '../system.service';
import si from 'systeminformation';
import fs from 'node:fs/promises';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('shared telemetry sampling', () => {
  it('shares each one-second sample across simultaneous viewers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    const service = new SystemService({} as never, {} as never, {} as never);
    let probes = 0;
    Reflect.set(service, 'readTelemetry', async () => ({ sampledAt: String(++probes) }));

    const [first, simultaneous] = await Promise.all([service.getTelemetry(), service.getTelemetry()]);
    expect(first).toBe(simultaneous);
    expect(probes).toBe(1);
    expect(await service.getTelemetry()).toBe(first);
    vi.advanceTimersByTime(999);
    expect(await service.getTelemetry()).toBe(first);
    vi.advanceTimersByTime(1);
    const refreshed = await service.getTelemetry();
    expect(refreshed).not.toBe(first);
    expect(probes).toBe(2);
  });

  it('refreshes CPU and memory without repeating disk commands every second or sampling while unused', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    const disks = vi.spyOn(si, 'fsSize').mockResolvedValue([]);
    vi.spyOn(si, 'networkStats').mockResolvedValue([]);
    vi.spyOn(si, 'currentLoad').mockResolvedValue({ currentLoad: 0, cpus: [] } as never);
    let tick = 0;
    const readTextFile = vi.fn(async (path: string) => {
      if (path.endsWith('/stat')) return `cpu ${100 + tick * 10} 0 0 ${100 + tick * 20} 0 0 0\ncpu0 ${100 + tick * 10} 0 0 ${100 + tick * 20} 0 0 0`;
      if (path.endsWith('/uptime')) return `${100 + tick} 0`;
      if (path.endsWith('/meminfo')) return `MemTotal: 1000 kB\nMemAvailable: ${800 - tick} kB`;
      return '';
    });
    const service = new SystemService({} as never, {} as never, { readTextFile } as never);
    Reflect.set(service, 'readRuntimeNetwork', async () => []);
    const first = await service.getTelemetry();
    for (tick = 1; tick < 10; tick++) {
      await vi.advanceTimersByTimeAsync(1000);
      const current = await service.getTelemetry();
      expect(current.sampledAt).not.toBe(first.sampledAt);
      expect(current.cpu.scope).toBe('host-proc');
      expect(current.memory.availableBytes).toBe((800 - tick) * 1024);
    }
    expect(disks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await service.getTelemetry();
    expect(disks).toHaveBeenCalledTimes(2);
    const reads = readTextFile.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(readTextFile).toHaveBeenCalledTimes(reads);
    expect(disks).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a failed disk probe without failing otherwise valid live readings', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    const disks = vi.spyOn(si, 'fsSize').mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValue([]);
    vi.spyOn(si, 'networkStats').mockResolvedValue([]);
    vi.spyOn(si, 'currentLoad').mockResolvedValue({ currentLoad: 0, cpus: [] } as never);
    const service = new SystemService({} as never, {} as never, { readTextFile: async () => null } as never);
    Reflect.set(service, 'readRuntimeNetwork', async () => []);
    await expect(service.getTelemetry()).resolves.toHaveProperty('filesystems', []);
    await vi.advanceTimersByTimeAsync(1000);
    await service.getTelemetry();
    expect(disks).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    await service.getTelemetry();
    expect(disks).toHaveBeenCalledTimes(2);
  });

  it('reads runtime counters directly, resets rates after idle, and retains the portable fallback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    vi.spyOn(si, 'fsSize').mockResolvedValue([]);
    const fallback = vi
      .spyOn(si, 'networkStats')
      .mockResolvedValue([{ iface: 'fallback', rx_bytes: 100, tx_bytes: 200, rx_sec: 12, tx_sec: 3 }] as never);
    const defaultInterface = vi.spyOn(si, 'networkInterfaceDefault').mockResolvedValue('eth0');
    let received = 0;
    let tick = 0;
    const proc = vi.spyOn(fs, 'readFile').mockImplementation(async () => {
      received += 1000;
      return `eth0: ${received} 0 0 0 0 0 0 0 9000 0 0 0 0 0 0 0`;
    });
    const service = new SystemService(
      {} as never,
      {} as never,
      {
        readTextFile: async (path: string) => {
          if (path.endsWith('/stat')) {
            tick++;
            return `cpu ${100 + tick * 10} 0 0 ${100 + tick * 10} 0 0 0`;
          }
          return '';
        },
      } as never,
    );
    expect((await service.getTelemetry()).network[0]).toMatchObject({ interface: 'eth0', rxBytesPerSecond: null, scope: 'runtime' });
    await vi.advanceTimersByTimeAsync(1000);
    const current = await service.getTelemetry();
    expect(current.network[0]).toMatchObject({ interface: 'eth0', rxBytesPerSecond: 1000, txBytesPerSecond: 0, scope: 'runtime' });
    expect(current.cpu.totalPercent).toBe(50);
    expect(defaultInterface).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(31_000);
    const resumed = await service.getTelemetry();
    expect(resumed.cpu.totalPercent).toBeNull();
    expect(resumed.network[0]?.rxBytesPerSecond).toBeNull();
    proc.mockRejectedValueOnce(new Error('proc not mounted'));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await service.getTelemetry()).network[0]).toMatchObject({ interface: 'fallback', rxBytesPerSecond: 12, scope: 'runtime' });
  });

  it('retries a failed sample', async () => {
    const service = new SystemService({} as never, {} as never, {} as never);
    let probes = 0;
    Reflect.set(service, 'readTelemetry', async () => {
      if (++probes === 1) throw new Error('probe failed');
      return { sampledAt: 'recovered' };
    });

    await expect(service.getTelemetry()).rejects.toThrow('probe failed');
    await expect(service.getTelemetry()).resolves.toHaveProperty('sampledAt', 'recovered');
    expect(probes).toBe(2);
  });
});
