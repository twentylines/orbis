import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('SentinelService local status', () => {
  let directory: string;
  let link: string;
  let socketPath: string;
  let server: http.Server | undefined;
  let oldPath: string | undefined;
  let calls: number;

  beforeEach(() => {
    oldPath = process.env.ORBIS_SENTINEL_SOCKET;
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
