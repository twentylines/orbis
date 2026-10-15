import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { SystemService } from '../system.service';
import { MetricHistoryService } from '../metric-history.service';
import { decodeBucket, encodeBucket, metricSample } from '../metric-history.model';

describe('bounded server metric history', () => {
  const system = mock<SystemService>();
  const config = mock<ConfigurationService>();
  const logger = mock<LoggerService>();
  let directory: string;
  let service: MetricHistoryService;
  const sample = (cpu: number | null = 20, scope = 'host-proc') => ({
    sampledAt: new Date().toISOString(),
    cpu: { scope, totalPercent: cpu, perCorePercent: [], uptimeSeconds: 100 },
    memory: { scope: 'host-proc', totalBytes: 100, availableBytes: 25, swapTotalBytes: null, swapFreeBytes: null },
    filesystems: [],
    network: [{ interface: 'eth0', scope: 'runtime', rxBytesPerSecond: 100, txBytesPerSecond: 50, receivedBytes: 1000, transmittedBytes: 500 }],
  });
  const file = () => path.join(directory, 'state', 'orbis-metrics', 'minutes-v1.jsonl');
  const collect = async (at: string | number, cpu: number | null = 20, scope = 'host-proc') => {
    vi.setSystemTime(new Date(at));
    system.getTelemetry.mockResolvedValue(sample(cpu, scope));
    await service.collect();
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T00:00:02Z'));
    system.getTelemetry.mockReset();
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbis-metrics-'));
    config.get.calledWith('directories').mockReturnValue({ dataDir: directory } as never);
    service = new MetricHistoryService(system, config, logger);
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    await fs.rm(directory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('persists measured minute averages and peaks across restart without inventing missing values', async () => {
    await collect('2026-10-15T00:00:02Z', 20);
    await collect('2026-10-15T00:00:12Z', 40);
    await collect('2026-10-15T00:00:22Z', null);
    await collect('2026-10-15T00:01:02Z', 10);
    await service.onModuleDestroy();
    const reloaded = new MetricHistoryService(system, config, logger);
    const history = await reloaded.read('1h');
    expect(history.points).toHaveLength(2);
    expect(history.points[0]).toMatchObject({
      at: '2026-10-15T00:00:02.000Z',
      until: '2026-10-15T00:00:22.000Z',
      samples: 3,
      cpu: { average: 30, peak: 40, samples: 2 },
      memory: { average: 75, peak: 75, samples: 3 },
    });
    expect(history.persistedThrough).toBe('2026-10-15T00:01:02.000Z');
    expect((await fs.stat(file())).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file()))).mode & 0o777).toBe(0o700);
    expect(history.collectorAvailable).toBe(false);
  });

  it('downsamples with sample weights and leaves incompatible CPU sources unavailable', async () => {
    await collect('2026-10-15T00:00:02Z', 20);
    await collect('2026-10-15T00:00:12Z', 20);
    await collect('2026-10-15T00:01:02Z', 80);
    expect((await service.read('24h')).points[0]?.cpu).toEqual({ average: 40, peak: 80, samples: 3 });
    await collect('2026-10-15T00:02:02Z', 90, 'runtime');
    const point = (await service.read('24h')).points[0];
    expect(point?.cpuScope).toBe('mixed');
    expect(point?.cpu).toEqual({ average: null, peak: null, samples: 0 });
    expect(point?.memory.average).toBe(75);
    expect((await service.read('1h')).points).toHaveLength(3);
  });

  it('retains the saved partial minute in the recent view after restart without counting new readings twice', async () => {
    await collect('2026-10-15T00:00:02Z', 20);
    await collect('2026-10-15T00:00:12Z', 40);
    await service.onModuleDestroy();
    service = new MetricHistoryService(system, config, logger);
    await collect('2026-10-15T00:00:32Z', 80);
    const recent = await service.read('5m');
    expect(recent.points).toHaveLength(2);
    expect(recent.points.map((point) => point.cpu)).toEqual([
      { average: 30, peak: 40, samples: 2 },
      { average: 80, peak: 80, samples: 1 },
    ]);
    expect((await service.read('1h')).points[0]?.cpu.samples).toBe(3);
  });

  it('coalesces collection, ignores repeated cached timestamps, and exposes interruption and staleness', async () => {
    let resolve: (value: ReturnType<typeof sample>) => void = () => undefined;
    system.getTelemetry.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const first = service.collect();
    const second = service.collect();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(system.getTelemetry).toHaveBeenCalledOnce());
    const reading = sample();
    resolve(reading);
    await first;
    system.getTelemetry.mockResolvedValue(reading);
    await service.collect();
    expect((await service.read('5m')).points).toHaveLength(1);
    system.getTelemetry.mockRejectedValue(new Error('Disconnected'));
    await service.collect();
    expect(await service.read('5m')).toMatchObject({ collectorAvailable: false, points: [{ samples: 1 }] });
    vi.advanceTimersByTime(31000);
    expect((await service.read('5m')).collectorAvailable).toBe(false);
  });

  it('collects on the server timer while no browser is requesting history', async () => {
    system.getTelemetry.mockImplementation(async () => sample());
    await service.onModuleInit();
    await service.collect();
    await vi.advanceTimersByTimeAsync(20000);
    expect(system.getTelemetry).toHaveBeenCalledTimes(3);
    expect((await service.read('5m')).points).toHaveLength(3);
  });

  it('bounds retention, output and journal growth through compaction', async () => {
    const now = Date.now();
    const rows = [];
    for (let index = 10090; index > 0; index--) {
      vi.setSystemTime(now - index * 60000);
      const bucket = metricSample(sample());
      if (bucket) rows.push(encodeBucket(bucket));
    }
    vi.setSystemTime(now);
    await fs.mkdir(path.dirname(file()), { recursive: true });
    await fs.writeFile(file(), `${rows.join('\n')}\n`);
    const history = await service.read('7d');
    expect(history.points.length).toBeLessThanOrEqual(338);
    expect(Date.parse(history.points[0]?.at ?? '')).toBeGreaterThanOrEqual(now - 7 * 86400000);
    await collect(now);
    await collect(now + 60000);
    await service.onModuleDestroy();
    const retained = (await fs.readFile(file(), 'utf8')).trim().split('\n');
    expect(retained.length).toBeLessThanOrEqual(10142);
    expect(new Set(retained.map((line) => decodeBucket(JSON.parse(line), Date.now()).bucketAt)).size).toBeLessThanOrEqual(10081);
    expect((await fs.stat(file())).size).toBeLessThan(4 * 1024 * 1024);
    expect(decodeBucket(JSON.parse(retained[0] ?? ''), Date.now()).lastAt).toBeGreaterThanOrEqual(Date.now() - 7 * 86400000);
  });

  it('preserves a corrupt journal and keeps valid earlier samples and new in-memory readings', async () => {
    const valid = metricSample(sample());
    await fs.mkdir(path.dirname(file()), { recursive: true });
    const source = `${valid ? encodeBucket(valid) : ''}\ntruncated-record`;
    await fs.writeFile(file(), source);
    await collect('2026-10-15T00:01:02Z');
    await service.onModuleDestroy();
    expect(await fs.readFile(file(), 'utf8')).toBe(source);
    expect(await service.read('1h')).toMatchObject({ storage: 'unavailable', points: [{ samples: 1 }, { samples: 1 }] });
  });

  it('continues collecting and reports a storage failure without overwriting an obstructing file', async () => {
    await fs.mkdir(path.join(directory, 'state'), { recursive: true });
    await fs.writeFile(path.dirname(file()), 'preserve-me');
    await collect('2026-10-15T00:00:02Z');
    await collect('2026-10-15T00:01:02Z');
    await service.onModuleDestroy();
    expect((await service.read('1h')).storage).toBe('unavailable');
    expect((await service.read('1h')).points).toHaveLength(2);
    expect(await fs.readFile(path.dirname(file()), 'utf8')).toBe('preserve-me');
  });

  it('rejects impossible memory, incomplete network and malformed stored metrics', async () => {
    const reading = sample();
    reading.memory.availableBytes = 200;
    const network = reading.network[0];
    if (network) network.rxBytesPerSecond = -1;
    const bucket = metricSample(reading);
    expect(bucket?.memory).toEqual([0, 0, 0]);
    expect(bucket?.download).toEqual([0, 0, 0]);
    expect(() => decodeBucket([0], Date.now())).toThrow();
    if (bucket) {
      const encoded = JSON.parse(encodeBucket(bucket));
      encoded[7] = 100;
      expect(() => decodeBucket(encoded, Date.now())).toThrow();
    }
  });
});
