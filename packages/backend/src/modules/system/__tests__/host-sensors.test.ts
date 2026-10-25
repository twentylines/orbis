import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostSensorsService, parseHostSensors } from '../host-sensors.service';

const temperature = () => ({
  id: `temperature:${'a'.repeat(16)}`,
  label: 'CPU package',
  chip: 'k10temp',
  status: 'available',
  celsius: 52.5,
  criticalCelsius: 95,
});
const fan = () => ({ id: `fan:${'b'.repeat(16)}`, label: 'Case fan', chip: 'nct6775', status: 'available', rpm: 0 });
const gpu = () => ({
  id: `gpu:${'c'.repeat(16)}`,
  label: 'card0',
  vendor: 'AMD',
  driver: 'amdgpu',
  utilizationPercent: 0,
  memoryUsedBytes: 3 * 1024 ** 3,
  memoryTotalBytes: 16 * 1024 ** 3,
});
const sample = () => ({
  available: true,
  sampledAt: new Date().toISOString(),
  stale: false,
  limited: false,
  unreadable: 0,
  temperatures: [temperature()],
  fans: [fan()],
  gpus: [gpu()],
  omitted: { temperatures: 0, fans: 0, gpus: 0 },
  unavailable: [],
});

describe('selected host sensor contract', () => {
  it('preserves actual Celsius, byte units and a stopped fan without inventing unavailable measurements', () => {
    const result = parseHostSensors(sample());
    expect(result).toMatchObject({
      available: true,
      temperatures: [{ celsius: 52.5, criticalCelsius: 95 }],
      fans: [{ status: 'available', rpm: 0 }],
      gpus: [{ utilizationPercent: 0, memoryUsedBytes: 3 * 1024 ** 3, memoryTotalBytes: 16 * 1024 ** 3 }],
    });
    expect(parseHostSensors({ ...sample(), temperatures: [], fans: [], gpus: [] })).toMatchObject({ available: true, unavailable: [] });
    expect(parseHostSensors({ ...sample(), temperatures: [], fans: [], unavailable: ['temperatures', 'fans'] })).toMatchObject({
      available: true,
      unavailable: ['temperatures', 'fans'],
    });
  });

  it.each(['fault', 'disabled', 'unavailable'])('keeps %s readings null and rejects inconsistent numeric states', (status) => {
    expect(
      parseHostSensors({ ...sample(), temperatures: [{ ...temperature(), status, celsius: null }], fans: [{ ...fan(), status, rpm: null }] }),
    ).toMatchObject({
      temperatures: [{ status, celsius: null }],
      fans: [{ status, rpm: null }],
    });
    expect(() => parseHostSensors({ ...sample(), temperatures: [{ ...temperature(), status }] })).toThrow();
    expect(() => parseHostSensors({ ...sample(), fans: [{ ...fan(), status }] })).toThrow();
  });

  it('rejects available channels without measured values', () => {
    expect(() => parseHostSensors({ ...sample(), temperatures: [{ ...temperature(), celsius: null }] })).toThrow();
    expect(() => parseHostSensors({ ...sample(), fans: [{ ...fan(), rpm: null }] })).toThrow();
  });

  it.each([-273.151, 1000.001, Number.NaN, Number.POSITIVE_INFINITY, '52.5'])('rejects invalid temperature %s', (celsius) => {
    expect(() => parseHostSensors({ ...sample(), temperatures: [{ ...temperature(), celsius }] })).toThrow();
  });

  it('accepts the documented temperature boundaries and rejects invalid fan/count/percentage/byte fields', () => {
    for (const celsius of [-273.15, 0, 1000]) {
      expect(parseHostSensors({ ...sample(), temperatures: [{ ...temperature(), celsius }] })).toMatchObject({ temperatures: [{ celsius }] });
    }
    for (const rpm of [-1, 0.5, 1_000_001, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseHostSensors({ ...sample(), fans: [{ ...fan(), rpm }] })).toThrow();
    }
    for (const field of ['utilizationPercent', 'memoryUsedBytes', 'memoryTotalBytes']) {
      expect(() => parseHostSensors({ ...sample(), gpus: [{ ...gpu(), [field]: -1 }] })).toThrow();
    }
    for (const value of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseHostSensors({ ...sample(), gpus: [{ ...gpu(), memoryTotalBytes: value }] })).toThrow();
    }
    expect(() => parseHostSensors({ ...sample(), gpus: [{ ...gpu(), utilizationPercent: 100.1 }] })).toThrow();
    expect(() => parseHostSensors({ ...sample(), gpus: [{ ...gpu(), memoryUsedBytes: 101, memoryTotalBytes: 100 }] })).toThrow();
  });

  it.each(['nvidia', 'i915', 'virtio_gpu', null])('requires unsupported %s GPU metrics to remain unavailable', (driver) => {
    const unsupported = { ...gpu(), driver, utilizationPercent: null, memoryUsedBytes: null, memoryTotalBytes: null };
    expect(parseHostSensors({ ...sample(), gpus: [unsupported] })).toMatchObject({ gpus: [unsupported] });
    for (const [field, value] of [
      ['utilizationPercent', 1],
      ['memoryUsedBytes', 0],
      ['memoryTotalBytes', 1024],
    ] as const) {
      expect(() => parseHostSensors({ ...sample(), gpus: [{ ...unsupported, [field]: value }] })).toThrow();
    }
  });

  it('selects only public fields and never exposes arbitrary helper error reasons', () => {
    const secret = 'RAW_SERIAL_BOOT_MAC_PRIVATE_SENTINEL';
    const result = parseHostSensors({
      ...sample(),
      serial: secret,
      bootId: secret,
      command: secret,
      temperatures: [{ ...temperature(), serial: secret }],
      fans: [{ ...fan(), raw: secret }],
      gpus: [{ ...gpu(), mac: secret, devicePath: secret }],
      omitted: { ...sample().omitted, raw: secret },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(parseHostSensors({ available: false, reason: secret })).toEqual({
      available: false,
      reason: 'Sensor readings are unavailable. Check the Orbis host service.',
    });
    expect(parseHostSensors({ available: false, reason: 'Collecting sensor readings.' })).toEqual({
      available: false,
      reason: 'Collecting sensor readings.',
    });
  });

  it('rejects malformed IDs, duplicate physical channels, hostile labels and excessive rows', () => {
    for (const id of ['temperature:/sys/private', 'temperature:short', `temperature:${'A'.repeat(16)}`, `fan:${'a'.repeat(16)}`]) {
      expect(() => parseHostSensors({ ...sample(), temperatures: [{ ...temperature(), id }] })).toThrow();
    }
    for (const field of ['label', 'chip']) {
      for (const text of ['', 'x'.repeat(129), 'CPU\npackage', 'CPU\u202epackage', 'CPU\u200bpackage']) {
        expect(() => parseHostSensors({ ...sample(), temperatures: [{ ...temperature(), [field]: text }] })).toThrow();
      }
    }
    expect(() => parseHostSensors({ ...sample(), temperatures: [temperature(), temperature()] })).toThrow();
    expect(() => parseHostSensors({ ...sample(), fans: [fan(), fan()] })).toThrow();
    expect(() => parseHostSensors({ ...sample(), gpus: [gpu(), gpu()] })).toThrow();
    for (const group of ['temperatures', 'fans', 'gpus']) {
      expect(() =>
        parseHostSensors({ ...sample(), [group]: Array(33).fill(group === 'gpus' ? gpu() : group === 'fans' ? fan() : temperature()) }),
      ).toThrow();
    }
  });

  it('rejects impossible coverage metadata and distinguishes missing hardware from read failures', () => {
    for (const unreadable of [-1, 0.5, 16385, Number.NaN]) {
      expect(() => parseHostSensors({ ...sample(), unreadable })).toThrow();
    }
    for (const unavailable of [['private'], ['fans', 'fans'], ['fans', 'temperatures', 'gpus', 'fans']]) {
      expect(() => parseHostSensors({ ...sample(), unavailable })).toThrow();
    }
    expect(() => parseHostSensors({ ...sample(), limited: 'yes' })).toThrow();
    expect(() => parseHostSensors({ ...sample(), omitted: { ...sample().omitted, gpus: 16385 } })).toThrow();
  });

  it('marks old readings stale while rejecting invalid and future sample clocks', () => {
    const now = Date.now();
    for (const [age, stale] of [
      [89999, false],
      [90000, false],
      [90001, true],
    ] as const) {
      expect(parseHostSensors({ ...sample(), sampledAt: new Date(now - age).toISOString() }, now)).toHaveProperty('stale', stale);
    }
    expect(parseHostSensors({ ...sample(), stale: true }, now)).toHaveProperty('stale', true);
    for (const sampledAt of ['private', new Date(now + 5001).toISOString(), 'x'.repeat(41)]) {
      expect(() => parseHostSensors({ ...sample(), sampledAt }, now)).toThrow();
    }
  });
});

describe('read-only sensors socket and shared cache', () => {
  const original = process.env.ORBIS_HOST_SOCKET;
  let directory: string;
  let socketPath: string;
  let server: http.Server;
  let body: unknown;
  let status: number;
  let held: boolean;
  let releases: (() => void)[];
  let calls: string[];
  const until = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      await pause(2);
    }
    throw new Error('Sensor socket fixture did not settle');
  };

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'orbis-sensor-socket-'));
    socketPath = path.join(directory, 'host.sock');
    server = http.createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      const send = () => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (held) releases.push(send);
      else send();
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });
  beforeEach(() => {
    process.env.ORBIS_HOST_SOCKET = socketPath;
    body = sample();
    status = 200;
    held = false;
    calls = [];
    releases = [];
  });
  afterEach(() => {
    for (const release of releases) release();
    vi.useRealTimers();
  });
  afterAll(async () => {
    if (original === undefined) delete process.env.ORBIS_HOST_SOCKET;
    else process.env.ORBIS_HOST_SOCKET = original;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('coalesces one fixed GET and expires success from request start despite response latency', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    held = true;
    const service = new HostSensorsService();
    const pending = service.read();
    expect(service.read()).toBe(pending);
    await until(() => releases.length === 1);
    vi.setSystemTime(start + 24000);
    releases.shift()?.();
    const first = await pending;
    vi.setSystemTime(start + 24999);
    expect(await service.read()).toEqual(first);
    expect(calls).toEqual(['GET /v1/sensors']);
    held = false;
    vi.setSystemTime(start + 25000);
    expect(await service.read()).not.toBe(first);
    expect(calls).toEqual(['GET /v1/sensors', 'GET /v1/sensors']);
  });

  it('never keeps a cached sample fresh after its ninety-second source-age boundary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    body = { ...sample(), sampledAt: new Date(start - 89000).toISOString() };
    const service = new HostSensorsService();
    expect(await service.read()).toHaveProperty('stale', false);
    vi.setSystemTime(start + 1001);
    expect(await service.read()).toHaveProperty('stale', true);
    expect(calls).toEqual(['GET /v1/sensors']);
    body = sample();
    vi.setSystemTime(start + 3001);
    expect(await service.read()).toHaveProperty('stale', false);
    expect(calls).toEqual(['GET /v1/sensors', 'GET /v1/sensors']);
  });

  it.each(['helper', 'age'])('rechecks a %s-stale snapshot after two seconds while preserving its actual readings', async (kind) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const sampledAt = new Date(start - (kind === 'age' ? 100_000 : 1000)).toISOString();
    body = { ...sample(), sampledAt, stale: kind === 'helper' };
    const service = new HostSensorsService();
    const previous = await service.read();
    expect(previous).toMatchObject({ available: true, stale: true, sampledAt, temperatures: [{ celsius: 52.5 }] });
    body = { ...sample(), temperatures: [{ ...temperature(), celsius: 53 }] };
    vi.setSystemTime(start + 1999);
    expect(await service.read()).toEqual(previous);
    expect(calls).toHaveLength(1);
    vi.setSystemTime(start + 2000);
    expect(await service.read()).toMatchObject({ available: true, stale: false, temperatures: [{ celsius: 53 }] });
    expect(calls).toEqual(['GET /v1/sensors', 'GET /v1/sensors']);
  });

  it.each([404, 500])('keeps safe %i unavailable responses for two seconds after completion', async (code) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    status = code;
    body = { reason: '/private/helper/error' };
    held = true;
    const service = new HostSensorsService();
    const pending = service.read();
    await until(() => releases.length === 1);
    vi.setSystemTime(start + 24000);
    releases.shift()?.();
    const first = await pending;
    expect(first).toHaveProperty('available', false);
    expect(JSON.stringify(first)).not.toContain('/private');
    if (code === 404) expect(first).toHaveProperty('reason', 'Update the Orbis host service to see sensors.');
    vi.setSystemTime(start + 25999);
    expect(await service.read()).toBe(first);
    held = false;
    vi.setSystemTime(start + 26000);
    await service.read();
    expect(calls).toHaveLength(2);
  });

  it('rejects invalid/oversized transport bodies and missing socket paths', async () => {
    body = { ...sample(), private: 'x'.repeat(256 * 1024) };
    expect(await new HostSensorsService().read()).toHaveProperty('available', false);
    body = { ...sample(), temperatures: [temperature(), temperature()] };
    expect(await new HostSensorsService().read()).toHaveProperty('available', false);
    const previous = calls.length;
    for (const value of ['', 'relative/socket', 'invalid\0socket']) {
      process.env.ORBIS_HOST_SOCKET = value;
      expect(await new HostSensorsService().read()).toHaveProperty('reason', 'Connect the Orbis host service to see sensors.');
    }
    expect(calls).toHaveLength(previous);
  });

  it('ends a blocked socket request within the whole-request deadline', async () => {
    held = true;
    const began = Date.now();
    expect(await new HostSensorsService().read()).toHaveProperty('available', false);
    expect(Date.now() - began).toBeLessThan(3000);
    expect(calls).toEqual(['GET /v1/sensors']);
  });
});
