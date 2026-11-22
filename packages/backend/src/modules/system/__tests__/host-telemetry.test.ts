import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostTelemetryService, parseHostTelemetry } from '../host-telemetry.service';

function sample() {
  return {
    available: true,
    stale: false,
    sampledAt: new Date().toISOString(),
    filesystems: [{ mount: '/srv/data', filesystem: 'ext4', sizeBytes: 1000, usedBytes: 500, availableBytes: 400, readOnly: false }],
    network: [
      { interface: 'eth0', state: 'up', speedMbps: 1000, receivedBytes: 2000, transmittedBytes: 3000, rxBytesPerSecond: null, txBytesPerSecond: 40 },
    ],
    disks: [{ device: 'sda', readBytes: 2000, writtenBytes: 3000, readBytesPerSecond: null, writeBytesPerSecond: 50, busyPercent: 10, inFlight: 1 }],
    omitted: { filesystems: 0, network: 0, disks: 0 },
    unavailable: [],
  };
}

describe('validated host device readings', () => {
  it('accepts a valid host battery and hides it for older helpers', () => {
    expect(parseHostTelemetry({ ...sample(), battery: { percent: 0, charging: null, extra: 'private' } })).toHaveProperty('battery', {
      percent: 0,
      charging: null,
    });
    expect(parseHostTelemetry(sample())).toHaveProperty('battery', null);
    for (const battery of [
      { percent: -1, charging: false },
      { percent: 101, charging: false },
      { percent: 10.5, charging: false },
      { percent: 10, charging: 'yes' },
    ]) {
      expect(parseHostTelemetry({ ...sample(), battery })).toHaveProperty('battery', null);
    }
  });
  it('keeps measured battery details and ignores unsupported private fields', () => {
    const battery = {
      percent: 76,
      charging: false,
      state: 'discharging',
      healthPercent: 92.4,
      powerWatts: 12.5,
      energyNowWh: 38,
      energyFullWh: 50,
      energyDesignWh: 54.1,
      timeRemainingSeconds: 10944,
      cycleCount: 173,
      manufacturer: 'Fixture',
      model: 'Laptop battery',
      batteryCount: 1,
    };
    expect(parseHostTelemetry({ ...sample(), battery: { ...battery, serialNumber: 'private' } })).toHaveProperty('battery', battery);
  });
  it('retains charge when optional battery readings are malformed', () => {
    const result = parseHostTelemetry({
      ...sample(),
      battery: {
        percent: 52,
        charging: null,
        healthPercent: 101,
        powerWatts: -1,
        cycleCount: 1.5,
        timeRemainingSeconds: Number.POSITIVE_INFINITY,
        model: 'bad\nlabel',
        batteryCount: 33,
      },
    });
    expect(result).toHaveProperty('battery', {
      percent: 52,
      charging: null,
      healthPercent: null,
      powerWatts: null,
      cycleCount: null,
      timeRemainingSeconds: null,
      model: null,
    });
  });
  it('preserves unavailable rates and strips fields outside the public contract', () => {
    const value = { ...sample(), commands: ['private'], mountOptions: 'secret' };
    const result = parseHostTelemetry(value);
    expect(result.available).toBe(true);
    expect(result).not.toHaveProperty('commands');
    expect(JSON.stringify(result)).not.toContain('secret');
    if (result.available) expect(result.network[0]?.rxBytesPerSecond).toBeNull();
  });

  it('rejects impossible counters, capacity, timestamps and excessive rows', () => {
    const invalid = [
      { ...sample(), filesystems: [{ ...sample().filesystems[0], usedBytes: 900 }] },
      { ...sample(), network: [{ ...sample().network[0], rxBytesPerSecond: -1 }] },
      { ...sample(), disks: [{ ...sample().disks[0], busyPercent: 101 }] },
      { ...sample(), filesystems: Array(33).fill(sample().filesystems[0]) },
      { ...sample(), sampledAt: new Date(Date.now() + 60_000).toISOString() },
      { ...sample(), sampledAt: 'invalid' },
      { ...sample(), filesystems: [{ ...sample().filesystems[0], mount: '/srv/\nprivate' }] },
      { ...sample(), omitted: { filesystems: -1, network: 0, disks: 0 } },
    ];
    for (const value of invalid) expect(() => parseHostTelemetry(value)).toThrow();
  });

  it('overrides an incorrectly fresh flag on an old host sample', () => {
    expect(parseHostTelemetry({ ...sample(), sampledAt: new Date(Date.now() - 31_000).toISOString() })).toHaveProperty('stale', true);
    expect(parseHostTelemetry({ available: false, reason: '/private/helper/error' })).toEqual({
      available: false,
      reason: 'Host readings are unavailable. Check the Orbis host service.',
    });
  });
});

describe('read-only host device socket', () => {
  const original = process.env.ORBIS_HOST_SOCKET;
  let directory: string;
  let server: http.Server;
  let socketPath: string;
  let body: unknown;
  let status: number;
  let hang: boolean;
  let calls: string[];
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'orbis-devices-'));
    socketPath = path.join(directory, 'host.sock');
    server = http.createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      if (hang) return;
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });
  beforeEach(() => {
    process.env.ORBIS_HOST_SOCKET = socketPath;
    body = sample();
    status = 200;
    hang = false;
    calls = [];
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    if (original === undefined) delete process.env.ORBIS_HOST_SOCKET;
    else process.env.ORBIS_HOST_SOCKET = original;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });

  it('coalesces readers within a live tick and permits a fresh one-second counter sample', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const service = new HostTelemetryService();
    const [first, second] = await Promise.all([service.read(), service.read()]);
    expect(first).toBe(second);
    expect(await service.read()).toBe(first);
    expect(calls).toEqual(['GET /v1/telemetry']);
    vi.setSystemTime(Date.now() + 799);
    expect(await service.read()).toBe(first);
    expect(calls).toHaveLength(1);
    vi.setSystemTime(Date.now() + 202);
    expect(await service.read()).not.toBe(first);
    expect(calls).toEqual(['GET /v1/telemetry', 'GET /v1/telemetry']);
  });

  it('retries stale samples quickly after asking the helper to refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    body = { ...sample(), stale: true };
    const service = new HostTelemetryService();
    await service.read();
    vi.setSystemTime(Date.now() + 2001);
    await service.read();
    expect(calls).toEqual(['GET /v1/telemetry', 'GET /v1/telemetry']);
  });

  it('treats older helpers as a missing capability without exposing their response', async () => {
    status = 404;
    body = { error: '/private/helper/details' };
    expect(await new HostTelemetryService().read()).toEqual({ available: false, reason: 'Update the Orbis host service to see host devices.' });
  });

  it('rejects oversized and invalid bodies', async () => {
    body = { private: 'x'.repeat(256 * 1024) };
    expect(await new HostTelemetryService().read()).toHaveProperty('available', false);
    body = { available: true, sampledAt: 'malformed' };
    expect(await new HostTelemetryService().read()).toHaveProperty('available', false);
  });

  it('ends a hung request within its whole-request deadline', async () => {
    hang = true;
    const start = Date.now();
    expect(await new HostTelemetryService().read()).toHaveProperty('available', false);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('does not contact a relative or missing socket', async () => {
    for (const value of ['', 'relative/socket', 'bad\0socket']) {
      process.env.ORBIS_HOST_SOCKET = value;
      expect(await new HostTelemetryService().read()).toHaveProperty('available', false);
    }
    expect(calls).toEqual([]);
  });
});
