import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemService } from '../system.service';

afterEach(() => vi.useRealTimers());

describe('shared telemetry sampling', () => {
  it('reuses a current sample across simultaneous viewers and refreshes after four seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    const service = new SystemService({} as never, {} as never, {} as never);
    let probes = 0;
    Reflect.set(service, 'readTelemetry', async () => ({ sampledAt: String(++probes) }));

    const [first, simultaneous] = await Promise.all([service.getTelemetry(), service.getTelemetry()]);
    expect(first).toBe(simultaneous);
    expect(probes).toBe(1);
    expect(await service.getTelemetry()).toBe(first);
    vi.advanceTimersByTime(4000);
    const refreshed = await service.getTelemetry();
    expect(refreshed).not.toBe(first);
    expect(probes).toBe(2);
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
