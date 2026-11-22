import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import http from 'node:http';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { Request } from 'express';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SentinelService } from './sentinel.service';

const unknown = { installedVersion: null, availableVersion: null, state: 'unknown' };
const payload = () => ({
  schema: 'orbis-sentinel.status.v1',
  protocolVersion: 1,
  components: { orbis: unknown, sentinel: { installedVersion: null, availableVersion: '1.2.3', state: 'healthy' } },
});
const unavailable = { available: false, ...unknown };

class TestService extends SentinelService {
  inspections = 0;
  replace = false;
  protected override async socketInfo(socketPath: string) {
    const info = await lstat(socketPath);
    this.inspections++;
    Object.defineProperty(info, 'uid', { value: 0 });
    if (this.replace && this.inspections === 2) Object.defineProperty(info, 'ino', { value: info.ino + 1 });
    return info;
  }
}

it('requires an authenticated operator before Main reads the Host progress route', async () => {
  const { SystemController } = await import('./system.controller');
  const { AuthGuard } = await import('../auth/auth.guard');
  const route = SystemController.prototype.sentinelUpdateProgress;
  expect(Reflect.getMetadata(GUARDS_METADATA, route)).toEqual([AuthGuard]);
  expect(Reflect.getMetadata(PATH_METADATA, route)).toBe('/sentinel/update-progress');
  const result = { version: 1, available: true, jobs: [] };
  const readUpdateProgress = vi.fn().mockResolvedValue(result);
  const controller = { sentinel: { readUpdateProgress } } as unknown as InstanceType<typeof SystemController>;
  for (const user of [undefined, { operator: false }, { operator: 'true' }]) {
    expect(() => route.call(controller, { user } as unknown as Request)).toThrow('An operator session is required.');
  }
  expect(readUpdateProgress).not.toHaveBeenCalled();
  await expect(route.call(controller, { user: { operator: true } } as Request)).resolves.toEqual(result);
  expect(readUpdateProgress).toHaveBeenCalledOnce();
});

describe('SentinelService local status', () => {
  let directory: string;
  let link: string;
  let socketPath: string;
  let server: http.Server | undefined;
  let oldPath: string | undefined;
  let oldHostPath: string | undefined;
  let calls: number;

  beforeEach(() => {
    oldPath = process.env.ORBIS_SENTINEL_SOCKET;
    oldHostPath = process.env.ORBIS_HOST_SOCKET;
    delete process.env.ORBIS_HOST_SOCKET;
    directory = mkdtempSync(path.join(os.tmpdir(), 'sentinel-'));
    const linkParent = process.env.ORBIS_TEST_SOCKET_DIR || os.tmpdir();
    link = path.join(linkParent, `sentinel-test-${process.pid}-${path.basename(directory)}`);
    symlinkSync(directory, link);
    socketPath = path.join(link, 's');
    process.env.ORBIS_SENTINEL_SOCKET = socketPath;
    calls = 0;
  });

  afterEach(async () => {
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    unlinkSync(link);
    rmSync(directory, { recursive: true, force: true });
    if (oldPath === undefined) delete process.env.ORBIS_SENTINEL_SOCKET;
    else process.env.ORBIS_SENTINEL_SOCKET = oldPath;
    if (oldHostPath === undefined) delete process.env.ORBIS_HOST_SOCKET;
    else process.env.ORBIS_HOST_SOCKET = oldHostPath;
  });

  async function start(handler: http.RequestListener = (_req, res) => res.end(JSON.stringify(payload()))) {
    server = http.createServer((req, res) => {
      calls++;
      handler(req, res);
    });
    await new Promise<void>((resolve, reject) => server?.once('error', reject).listen(socketPath, resolve));
    chmodSync(socketPath, 0o600);
  }

  it('reads the exact endpoint, accepts null versions and coalesces cached reads', async () => {
    await start((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/sentinel/api/v1/status');
      res.end(JSON.stringify(payload()));
    });
    const service = new TestService();
    const results = await Promise.all([service.read(), service.read(), service.read()]);
    expect(results).toEqual(Array(3).fill({ available: true, installedVersion: null, availableVersion: '1.2.3', state: 'healthy' }));
    await service.read();
    expect(calls).toBe(1);
    expect(service.inspections).toBe(2);
  });

  it('reads Sentinel through the protected host socket when no direct socket is configured', async () => {
    delete process.env.ORBIS_SENTINEL_SOCKET;
    process.env.ORBIS_HOST_SOCKET = socketPath;
    await start((req, res) => {
      expect(req.url).toBe('/v1/sentinel/status');
      res.end(JSON.stringify({ version: 1, available: true, status: payload() }));
    });
    const service = new TestService();
    const results = await Promise.all([service.read(), service.read()]);
    expect(results).toEqual(Array(2).fill({ available: true, ...payload().components.sentinel }));
    expect(calls).toBe(1);
    expect(service.inspections).toBe(2);
  });

  it('reads only the authorized progress socket route and discards old, malformed and replaced helpers', async () => {
    process.env.ORBIS_HOST_SOCKET = socketPath;
    let status = 404;
    const job = { id: 'a'.repeat(32), version: '1.2.3', phase: 'installing', startedAt: 100, updatedAt: 200, download: null };
    const snapshot = { version: 1, available: true, jobs: [job] };
    let body: unknown = snapshot;
    await start((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/v1/sentinel/update-progress');
      expect(req.headers['content-length']).toBeUndefined();
      res.statusCode = status;
      res.end(JSON.stringify(body));
    });
    const missing = { version: 1, available: false, jobs: [] };
    const service = new TestService();
    expect(await service.readUpdateProgress()).toEqual(missing);
    status = 200;
    expect(await service.readUpdateProgress()).toEqual(snapshot);
    for (body of [
      { ...snapshot, jobs: [{ ...job, pid: 123, path: '/private' }] },
      { ...snapshot, jobs: [job, job] },
      { ...snapshot, jobs: Array(17).fill(job) },
      { ...snapshot, version: 2 },
      'a'.repeat(8192),
    ])
      expect(await service.readUpdateProgress()).toEqual(missing);
    body = snapshot;
    const replaced = new TestService();
    replaced.replace = true;
    expect(await replaced.readUpdateProgress()).toEqual(missing);
  });

  it('keeps older helpers and invalid host envelopes unavailable', async () => {
    delete process.env.ORBIS_SENTINEL_SOCKET;
    process.env.ORBIS_HOST_SOCKET = socketPath;
    let status = 404;
    let body: unknown = {};
    await start((_req, res) => {
      res.statusCode = status;
      res.end(JSON.stringify(body));
    });
    expect(await new TestService().read()).toEqual(unavailable);
    status = 200;
    for (body of [
      { version: 1, available: false, status: null },
      { version: 2, available: true, status: payload() },
      { version: 1, available: true, status: payload(), extra: true },
      { version: 1, available: true, status: {} },
    ])
      expect(await new TestService().read()).toEqual(unavailable);
  });

  it('reads the fixed recovery route on Host even when a direct Sentinel status socket is configured', async () => {
    process.env.ORBIS_HOST_SOCKET = socketPath;
    process.env.ORBIS_SENTINEL_SOCKET = '/unused-direct-sentinel.sock';
    const configured = { state: 'configured', portalUrl: 'https://recovery.example:8443/sentinel/recovery/', unitState: 'active' };
    let body: unknown = { version: 1, ...configured };
    await start((req, res) => {
      expect(req.method).toBe('GET');
      expect(req.url).toBe('/v1/sentinel/recovery-access');
      expect(req.headers['content-length']).toBeUndefined();
      res.end(JSON.stringify(body));
    });
    const service = new TestService();
    expect(await Promise.all([service.readRecoveryAccess(), service.readRecoveryAccess()])).toEqual([configured, configured]);
    expect(calls).toBe(1);
    body = { version: 1, state: 'missing', portalUrl: null, unitState: null };
    expect(await service.readRecoveryAccess()).toEqual({ state: 'missing', portalUrl: null, unitState: null });
    expect(calls).toBe(2);
  });

  it('suppresses URLs on old helpers, oversized replies, unsafe URLs and changed socket identity', async () => {
    process.env.ORBIS_HOST_SOCKET = socketPath;
    const unknownAccess = { state: 'unavailable', portalUrl: null, unitState: null };
    const configured = { version: 1, state: 'configured', portalUrl: 'https://recovery.example/sentinel/recovery/', unitState: 'active' };
    let statusCode = 404;
    let body: unknown = configured;
    await start((_req, res) => {
      res.statusCode = statusCode;
      res.end(JSON.stringify(body));
    });
    const service = new TestService();
    expect(await service.readRecoveryAccess()).toEqual(unknownAccess);
    statusCode = 403;
    expect(await service.readRecoveryAccess()).toEqual(unknownAccess);
    statusCode = 200;
    body = { ...configured, enrollment: 'operator-staged' };
    expect(await service.readRecoveryAccess()).toEqual({
      state: 'configured',
      portalUrl: configured.portalUrl,
      unitState: 'active',
      enrollment: 'operator-staged',
    });
    for (body of [
      { ...configured, portalUrl: 'https://recovery.example@elsewhere.example/sentinel/recovery/' },
      { ...configured, portalUrl: 'https://recovery.example/sentinel/recovery/?extra' },
      { ...configured, portalUrl: 'https://recovery.example:0/sentinel/recovery/' },
      { ...configured, unitState: 'ready' },
      { ...configured, enrollment: 'unknown' },
      { ...configured, enrollment: 'activated', unitState: 'inactive' },
      { ...configured, extra: true },
      'x'.repeat(1024),
    ])
      expect(await service.readRecoveryAccess()).toEqual(unknownAccess);
    body = configured;
    const replaced = new TestService();
    replaced.replace = true;
    expect(await replaced.readRecoveryAccess()).toEqual(unknownAccess);
  });

  it('bounds a recovery helper that accepts the connection and never replies', async () => {
    process.env.ORBIS_HOST_SOCKET = socketPath;
    await start(() => {});
    const started = performance.now();
    expect(await new TestService().readRecoveryAccess()).toEqual({ state: 'unavailable', portalUrl: null, unitState: null });
    expect(calls).toBe(1);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('posts only fixed handoff bindings and rejects extra secret-bearing response fields', async () => {
    process.env.ORBIS_HOST_SOCKET = socketPath;
    const binding = {
      operationId: 'a'.repeat(64),
      reviewSha256: 'b'.repeat(64),
      planSha256: 'c'.repeat(64),
      keyRevision: 'd'.repeat(64),
      deliveryEpoch: 'e'.repeat(64),
      handoff: 'A'.repeat(43),
    };
    const fakeKey = `orbis-recovery-${'B'.repeat(42)}A`;
    let result = { recoveryKey: fakeKey };
    await start(async (request, response) => {
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/v1/sentinel/enrollment/save-key');
      const buffers = [];
      for await (const chunk of request) buffers.push(chunk);
      expect(JSON.parse(Buffer.concat(buffers).toString())).toEqual(binding);
      response.end(JSON.stringify(result));
    });
    const service = new TestService();
    await expect(service.recoveryKeyHandoff('save', binding)).resolves.toEqual({ recoveryKey: fakeKey });
    await expect(service.recoveryKeyHandoff('save', { ...binding, operation: 'bootstrap-browser-authorize' })).rejects.toThrow(
      'Invalid recovery handoff.',
    );
    result = { ...result, other: 'synthetic extra' } as typeof result;
    await expect(service.recoveryKeyHandoff('save', binding)).rejects.toThrow('The host could not verify this recovery handoff.');
  });

  it('does not replace invalid explicit Sentinel configuration with the host bridge', async () => {
    process.env.ORBIS_SENTINEL_SOCKET = 'relative';
    process.env.ORBIS_HOST_SOCKET = socketPath;
    await start();
    expect(await new TestService().read()).toEqual(unavailable);
    expect(calls).toBe(0);
  });

  it('separates direct and host cache entries even when they share a socket pathname', async () => {
    process.env.ORBIS_HOST_SOCKET = socketPath;
    await start((req, res) =>
      res.end(JSON.stringify(req.url === '/v1/sentinel/status' ? { version: 1, available: false, status: null } : payload())),
    );
    const service = new TestService();
    expect((await service.read()).available).toBe(true);
    delete process.env.ORBIS_SENTINEL_SOCKET;
    expect(await service.read()).toEqual(unavailable);
    expect(calls).toBe(2);
  });

  it('treats absent or nonabsolute configuration as unavailable', async () => {
    delete process.env.ORBIS_SENTINEL_SOCKET;
    const service = new TestService();
    expect(await service.read()).toEqual(unavailable);
    process.env.ORBIS_SENTINEL_SOCKET = 'relative';
    expect(await service.read()).toEqual(unavailable);
    process.env.ORBIS_SENTINEL_SOCKET = `/${'x'.repeat(108)}`;
    expect(await service.read()).toEqual(unavailable);
    expect(service.inspections).toBe(0);
  });

  it('rejects malformed, extra, invalid-version and oversized documents', async () => {
    let content = '';
    await start((_req, res) => res.end(content));
    const bad = [
      '{',
      JSON.stringify({ ...payload(), extra: true }),
      JSON.stringify({ ...payload(), components: { ...payload().components, orbis: { ...unknown, state: 'fiction' } } }),
      ...['01.2.3', '1.2.3\n', '1.2.3\u2028'].map((version) =>
        JSON.stringify({ ...payload(), components: { ...payload().components, sentinel: { ...unknown, installedVersion: version } } }),
      ),
      'x'.repeat(65537),
    ];
    for (const value of bad) {
      content = value;
      expect(await new TestService().read()).toEqual(unavailable);
    }
  });

  it('rejects writable and symlink sockets before making a request', async () => {
    await start();
    chmodSync(socketPath, 0o666);
    expect(await new TestService().read()).toEqual(unavailable);
    chmodSync(socketPath, 0o600);
    symlinkSync('s', path.join(link, 'link'));
    process.env.ORBIS_SENTINEL_SOCKET = path.join(link, 'link');
    expect(await new TestService().read()).toEqual(unavailable);
    expect(calls).toBe(0);
  });

  it('rejects a changed socket identity after receiving a response', async () => {
    await start();
    const service = new TestService();
    service.replace = true;
    expect(await service.read()).toEqual(unavailable);
    expect(calls).toBe(1);
  });

  it('applies a fixed deadline and coalesces unavailable results', async () => {
    await start((_req, res) => {
      res.writeHead(200);
      res.write('{');
    });
    const service = new TestService();
    const started = Date.now();
    expect(await Promise.all([service.read(), service.read()])).toEqual([unavailable, unavailable]);
    expect(Date.now() - started).toBeLessThan(2600);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1800);
    expect(await service.read()).toEqual(unavailable);
    expect(calls).toBe(1);
  }, 4000);

  it('rejects a real socket replacement after the response', async () => {
    await start((_req, res) => {
      unlinkSync(socketPath);
      symlinkSync('other', socketPath);
      res.end(JSON.stringify(payload()));
    });
    expect(await new TestService().read()).toEqual(unavailable);
  });
});
