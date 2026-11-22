import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import si from 'systeminformation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSentinelSystemReadings, readSentinelSystemReadings } from './sentinel-system-readings';
import { HostMemoryService } from './host-memory.service';
import { SystemService } from './system.service';

const now = Date.parse('2026-11-19T02:00:00Z');
const reading = (time = now - 200) => ({
  schema: 'orbis-sentinel.system-readings.v1',
  state: 'ready',
  ageMs: 200,
  sample: {
    sampledAt: time,
    cpu: { model: 'Actual host CPU', reportedClockGHz: 2.4, totalPercent: 59, perCorePercent: [0, 62], uptimeSeconds: 11.8 },
    memory: { totalBytes: 8192, availableBytes: 2048, swapTotalBytes: 0, swapFreeBytes: 0 },
  },
});

describe('Sentinel system readings', () => {
  let directory: string | undefined;
  let server: http.Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
    server = undefined;
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function listen(handler: http.RequestListener) {
    directory = await mkdtemp(path.join(process.env.ORBIS_TEST_SOCKET_DIR ?? os.tmpdir(), 'sr-'));
    const socket = path.join(directory, 's');
    server = http.createServer(handler);
    await new Promise<void>((resolve, reject) => server?.once('error', reject).listen(socket, resolve));
    return socket;
  }

  function reply(response: http.ServerResponse, body: unknown, type = 'application/json') {
    const json = JSON.stringify(body);
    response.writeHead(200, { 'content-type': type, 'content-length': Buffer.byteLength(json) });
    response.end(json);
  }

  it('accepts real measured CPU, memory and swap including zero usage while rejecting incomplete or stale groups', () => {
    const value = reading();
    expect(parseSentinelSystemReadings(value, now)).toEqual({
      sampledAt: now - 200,
      cpu: { scope: 'host-proc', ...value.sample.cpu },
      memory: { scope: 'host-proc', ...value.sample.memory },
    });
    for (const invalid of [
      { ...value, state: 'starting' },
      { ...value, state: 'stale' },
      { ...value, ageMs: 3001 },
      { ...value, ageMs: 1.5 },
      reading(now + 1),
      reading(now - 3001),
      { ...value, extra: true },
      { ...value, sample: { ...value.sample, cpu: { ...value.sample.cpu, model: '' } } },
      { ...value, sample: { ...value.sample, cpu: { ...value.sample.cpu, reportedClockGHz: null } } },
      { ...value, sample: { ...value.sample, cpu: { ...value.sample.cpu, totalPercent: Number.NaN } } },
      { ...value, sample: { ...value.sample, cpu: { ...value.sample.cpu, perCorePercent: [null, 62] } } },
      { ...value, sample: { ...value.sample, cpu: { ...value.sample.cpu, perCorePercent: Array(257).fill(1) } } },
      { ...value, sample: { ...value.sample, memory: { ...value.sample.memory, swapFreeBytes: 1 } } },
    ])
      expect(parseSentinelSystemReadings(invalid, now)).toBeNull();
  });

  it('uses only the fixed Unix GET and falls back on older helpers, bad framing, oversized bodies and a stalled read', async () => {
    let mode = 'ready';
    const requests: [string | undefined, string | undefined][] = [];
    const socket = await listen((request, response) => {
      requests.push([request.method, request.url]);
      if (mode === 'old') {
        response.writeHead(404);
        response.end();
      } else if (mode === 'invalid') reply(response, reading(Date.now()), 'text/plain');
      else if (mode === 'oversize') reply(response, { body: 'x'.repeat(16 * 1024) });
      else if (mode === 'ready') reply(response, reading(Date.now()));
    });
    expect(await readSentinelSystemReadings(socket)).toMatchObject({ cpu: { reportedClockGHz: 2.4 } });
    for (mode of ['old', 'invalid', 'oversize', 'stall']) expect(await readSentinelSystemReadings(socket)).toBeNull();
    expect(requests).toEqual(Array(5).fill(['GET', '/v1/sentinel/system-readings']));
    expect(await readSentinelSystemReadings('relative')).toBeNull();
  });

  it('keeps one sample for simultaneous readers, preserves runtime projections and resets the legacy CPU baseline on a provider switch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    let mode = 'old';
    let requests = 0;
    const socket = await listen((_, response) => {
      requests++;
      if (mode === 'old') {
        response.writeHead(404);
        response.end();
      } else if (mode === 'stale') reply(response, reading(Date.now() - 3001));
      else if (mode === 'regressed') reply(response, reading(Date.now() - 1500));
      else reply(response, reading(Date.now() - 200));
    });
    vi.stubEnv('ORBIS_HOST_SOCKET', socket);
    vi.spyOn(si, 'fsSize').mockResolvedValue([{ mount: '/', fs: 'overlay', used: 30, available: 70, size: 100 }] as never);
    let ticks = 0;
    const readTextFile = vi.fn(async (filename: string) => {
      if (filename.endsWith('/stat')) {
        ticks += 10;
        return `cpu ${100 + ticks} 0 0 ${100 + ticks}\ncpu0 ${100 + ticks} 0 0 ${100 + ticks}\n`;
      }
      if (filename.endsWith('/cpuinfo')) return 'model name : Legacy actual model\ncpu MHz : 2100.0\n';
      if (filename.endsWith('/meminfo')) return 'MemTotal: 1024 kB\nMemAvailable: 400 kB\nSwapTotal: 12 kB\nSwapFree: 10 kB\n';
      return '70.3 45.8\n';
    });
    const service = systemService({} as never, {} as never, { readTextFile } as never);
    Reflect.set(service, 'readRuntimeNetwork', async () => [{ iface: 'eth0', rx_sec: 17, tx_sec: 8, rx_bytes: 951, tx_bytes: 622 }]);

    const legacy = await service.getTelemetry();
    expect(legacy.cpu).toMatchObject({ model: 'Legacy actual model', reportedClockGHz: 2.1, totalPercent: null });
    const legacyReads = readTextFile.mock.calls.length;
    mode = 'preferred';
    vi.setSystemTime(now + 1000);
    const [preferred, same] = await Promise.all([service.getTelemetry(), service.getTelemetry()]);
    expect(preferred).toBe(same);
    expect(requests).toBe(2);
    expect(readTextFile).toHaveBeenCalledTimes(legacyReads);
    expect(preferred.sampledAt).toBe(new Date(now + 800).toISOString());
    expect(preferred.cpu).toMatchObject({ model: 'Actual host CPU', reportedClockGHz: 2.4, perCorePercent: [0, 62], totalPercent: 59 });
    expect(preferred.memory).toMatchObject({ availableBytes: 2048, swapTotalBytes: 0 });
    expect(preferred.network).toEqual(legacy.network);
    expect(preferred.filesystems).toEqual(legacy.filesystems);

    mode = 'stale';
    vi.setSystemTime(now + 2000);
    const recovered = await service.getTelemetry();
    expect(recovered.cpu).toMatchObject({ model: 'Legacy actual model', reportedClockGHz: 2.1, totalPercent: null, perCorePercent: [null] });
    expect(recovered.memory).toMatchObject({ availableBytes: 400 * 1024, swapTotalBytes: 12 * 1024 });
    mode = 'regressed';
    vi.setSystemTime(now + 3000);
    expect((await service.getTelemetry()).cpu).toMatchObject({ model: 'Legacy actual model', totalPercent: 50 });
  });

  it('uses the legacy group if another runtime probe outlasts a previously fresh Sentinel sample', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    vi.stubEnv('ORBIS_HOST_SOCKET', await listen((_, response) => reply(response, reading())));
    vi.spyOn(si, 'fsSize').mockResolvedValue([]);
    vi.spyOn(si, 'currentLoad').mockResolvedValue({ currentLoad: 0, cpus: [] } as never);
    const service = systemService(
      {} as never,
      {} as never,
      {
        readTextFile: async (filename: string) => (filename.endsWith('/cpuinfo') ? 'model name : Legacy actual model\ncpu MHz : 2100.0\n' : null),
      } as never,
    );
    const readHost = Reflect.get(service, 'readHostSystem').bind(service);
    let resume!: () => void;
    const network = new Promise<Array<never>>((resolve) => {
      resume = () => resolve([]);
    });
    Reflect.set(service, 'readHostSystem', async () => {
      const original = await readHost();
      expect(original.source).toBe('sentinel');
      vi.setSystemTime(now + 3000);
      resume();
      return original;
    });
    Reflect.set(service, 'readRuntimeNetwork', () => network);
    expect(await service.getTelemetry()).toMatchObject({
      sampledAt: new Date(now + 3000).toISOString(),
      cpu: { model: 'Legacy actual model', reportedClockGHz: 2.1 },
    });
  });
});

const systemService = (_logger: never, config: never, filesystem: never) =>
  new SystemService(config, filesystem, new HostMemoryService({ error: vi.fn() } as never, { get: () => 0 } as never, filesystem, {} as never));
