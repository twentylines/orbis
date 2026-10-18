import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostProcessesService, parseHostProcesses } from '../host-processes.service';

function sample() {
  const rows = [
    { pid: 1, name: 'worker', cpuPercent: 250, memoryBytes: 1024 },
    { pid: 2, name: 'server ) worker', cpuPercent: 10, memoryBytes: 8192 },
    { pid: 3, name: 'new-worker', cpuPercent: null, memoryBytes: 4096 },
  ];
  return {
    available: true,
    stale: false,
    sampledAt: new Date().toISOString(),
    scanned: 4,
    readable: 3,
    unreadable: 1,
    compared: 2,
    limited: false,
    byCpu: rows.slice(0, 2),
    byMemory: [rows[1], rows[2], rows[0]],
  };
}

describe('host process contract', () => {
  it('selects only process identity and readings, retaining multicore CPU and unknown first samples', () => {
    const value = sample();
    const result = parseHostProcesses({
      ...value,
      cmdline: 'private-token',
      byCpu: value.byCpu.map((row) => ({ ...row, environ: 'private-token' })),
    });
    expect(result).toEqual(value);
    expect(JSON.stringify(result)).not.toContain('private-token');
    expect(
      parseHostProcesses({ ...value, compared: 0, byCpu: [], byMemory: value.byMemory.map((row) => ({ ...row, cpuPercent: null })) }),
    ).toHaveProperty('byCpu', []);
  });

  it('rejects inconsistent coverage, duplicate identities, wrong order and conflicting shared rows', () => {
    const value = sample();
    const invalid = [
      { ...value, scanned: 8193 },
      { ...value, readable: 5 },
      { ...value, unreadable: 0 },
      { ...value, compared: 4 },
      { ...value, compared: 21 },
      { ...value, byMemory: [] },
      { ...value, byCpu: [...value.byCpu].reverse() },
      { ...value, byMemory: [value.byMemory[0], value.byMemory[0], value.byMemory[2]] },
      { ...value, byMemory: value.byMemory.map((row) => ({ ...row, memoryBytes: 999 })) },
      { ...value, byCpu: value.byCpu.map((row) => ({ ...row, cpuPercent: null })) },
      { ...value, byCpu: value.byCpu.map((row) => ({ ...row, cpuPercent: Number.NaN })) },
      { ...value, byCpu: value.byCpu.map((row) => ({ ...row, name: 'private\nline' })) },
      { ...value, byCpu: value.byCpu.map((row) => ({ ...row, memoryBytes: -1 })) },
      { ...value, byCpu: value.byCpu.map((row) => ({ ...row, pid: 0 })) },
      { ...value, sampledAt: 'invalid' },
      { ...value, sampledAt: new Date(Date.now() + 60_000).toISOString() },
    ];
    for (const bad of invalid) expect(() => parseHostProcesses(bad)).toThrow();
  });

  it('does not call old readings fresh or disclose raw helper errors', () => {
    expect(parseHostProcesses({ ...sample(), sampledAt: new Date(Date.now() - 31_000).toISOString() })).toHaveProperty('stale', true);
    expect(parseHostProcesses({ available: false, reason: '/private/host/file' })).toEqual({
      available: false,
      reason: 'Process readings are unavailable. Check the Orbis host service.',
    });
    expect(parseHostProcesses({ available: false, reason: 'Collecting process readings.' })).toHaveProperty('reason', 'Collecting process readings.');
  });
});

describe('shared fixed-path process transport', () => {
  const original = process.env.ORBIS_HOST_SOCKET;
  let directory: string;
  let server: http.Server;
  let body: unknown;
  let status: number;
  let calls: string[];
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'orbis-processes-'));
    server = http.createServer((request, response) => {
      calls.push(`${request.method} ${request.url}`);
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(path.join(directory, 'host.sock'), resolve));
  });
  beforeEach(() => {
    process.env.ORBIS_HOST_SOCKET = path.join(directory, 'host.sock');
    body = sample();
    status = 200;
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
  it('coalesces viewers with a ten-second shared cache and always uses the exact read-only path', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const service = new HostProcessesService();
    const [first, second] = await Promise.all([service.read(), service.read()]);
    expect(first).toBe(second);
    expect(await service.read()).toBe(first);
    expect(calls).toEqual(['GET /v1/processes']);
    vi.setSystemTime(Date.now() + 10_001);
    expect(await service.read()).not.toBe(first);
    expect(calls).toHaveLength(2);
  });
  it('reports old helpers as an unavailable capability and retries failure after two seconds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    status = 404;
    body = { error: '/private/host/file' };
    const service = new HostProcessesService();
    expect(await service.read()).toEqual({ available: false, reason: 'Update the Orbis host service to see processes.' });
    status = 200;
    body = sample();
    expect(await service.read()).toHaveProperty('available', false);
    vi.setSystemTime(Date.now() + 2001);
    expect(await service.read()).toHaveProperty('available', true);
  });
  it('rejects an oversized response and invalid selected fields', async () => {
    body = { private: 'x'.repeat(256 * 1024) };
    expect(await new HostProcessesService().read()).toHaveProperty('available', false);
    body = { ...sample(), byCpu: [] };
    expect(await new HostProcessesService().read()).toHaveProperty('available', false);
  });
  it('does not keep the first CPU comparison behind an extra ten-second cache', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    body = { ...sample(), compared: 0, byCpu: [], byMemory: sample().byMemory.map((row) => ({ ...row, cpuPercent: null })) };
    const service = new HostProcessesService();
    expect(await service.read()).toHaveProperty('compared', 0);
    body = sample();
    vi.setSystemTime(Date.now() + 2001);
    expect(await service.read()).toHaveProperty('compared', 2);
  });
});
