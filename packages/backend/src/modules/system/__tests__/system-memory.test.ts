import { afterEach, expect, test, vi } from 'vitest';
import si from 'systeminformation';
import type { HostMemory, HostMemoryService } from '../host-memory.service';
import { SystemService } from '../system.service';
import { metricSample } from '../metric-history.model';

afterEach(() => vi.restoreAllMocks());

const setup = (memory: HostMemory | Error) => {
  vi.spyOn(si, 'currentLoad').mockResolvedValue({ currentLoad: 1, cpus: [] } as never);
  vi.spyOn(si, 'fsSize').mockResolvedValue([]);
  const getMemory = vi.fn(async () => {
    if (memory instanceof Error) throw memory;
    return memory;
  });
  const service = new SystemService({} as never, { readTextFile: async () => null } as never, { getMemory } as unknown as HostMemoryService);
  Reflect.set(service, 'readRuntimeNetwork', async () => []);
  Reflect.set(service, 'readCpuInformation', async () => '');
  return { service, getMemory };
};

test.each(['host', 'cgroup', 'containers', 'runtime'] as const)('reports byte-accurate %s usage with an explicit scope', async (source) => {
  const { service } = setup({ total: 8 * 1024 ** 3, used: 1024 ** 3 / 4, source });
  expect(await service.getSystemLoad()).toMatchObject({ memoryTotal: 8, percentUsedMemory: 3.1, memorySource: source });
  const current = await service.getTelemetry();
  expect(current.memory).toEqual({
    scope: source === 'host' ? 'host-proc' : source,
    totalBytes: 8 * 1024 ** 3,
    availableBytes: 8 * 1024 ** 3 - 1024 ** 3 / 4,
    swapTotalBytes: null,
    swapFreeBytes: null,
  });
  expect(metricSample(current)?.memoryScope).toBe(current.memory.scope);
});

test('keeps unavailable memory as a gap without discarding other live readings', async () => {
  const { service } = setup(new Error('memory unavailable'));
  const sample = await service.getTelemetry();
  expect(sample.cpu.totalPercent).toBe(1);
  expect(sample.memory).toEqual({ scope: 'unavailable', totalBytes: null, availableBytes: null, swapTotalBytes: null, swapFreeBytes: null });
  expect(metricSample(sample)?.memory).toEqual([0, 0, 0]);
  await expect(service.getSystemLoad()).rejects.toThrow('Memory usage is temporarily unavailable');
});

test('uses valid Sentinel memory without probing the fallback reader', async () => {
  const { service, getMemory } = setup(new Error('fallback must not be read'));
  Reflect.set(service, 'readHostSystem', async () => ({
    source: 'sentinel',
    sample: {
      sampledAt: Date.now(),
      cpu: { scope: 'host-proc', totalPercent: 20, perCorePercent: [], uptimeSeconds: 5 },
      memory: { scope: 'host-proc', totalBytes: 100, availableBytes: 25, swapTotalBytes: 10, swapFreeBytes: 8 },
    },
  }));
  expect((await service.getTelemetry()).memory).toEqual({
    scope: 'host-proc',
    totalBytes: 100,
    availableBytes: 25,
    swapTotalBytes: 10,
    swapFreeBytes: 8,
  });
  expect(await service.getSystemLoad()).toMatchObject({ percentUsedMemory: 75, memorySource: 'host', cpuLoad: 20 });
  expect(getMemory).not.toHaveBeenCalled();
});
