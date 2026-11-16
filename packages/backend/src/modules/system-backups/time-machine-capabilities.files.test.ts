import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { coreCaptureReservedStartCapability } from '../host-updates/host-core-capture-reserved-start-client';
import { coreCaptureSentinelStartCapability } from '../host-updates/host-core-capture-start-client';
import { TimeMachineService } from './time-machine.service';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.unstubAllEnvs();
});
async function fixture(wired = true) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'cap-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const socket = path.join(root, 's');
  const requests: { method: string | undefined; url: string | undefined }[] = [];
  const state = { status: 200, value: coreCaptureReservedStartCapability as unknown, sentinel: false, hang: false };
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    if (state.hang) return;
    const sentinel = request.url?.endsWith('/sentinel-start-capability');
    const value = sentinel
      ? state.sentinel
        ? { ...coreCaptureSentinelStartCapability, available: true }
        : { error: 'Unsupported route' }
      : state.value;
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(sentinel && !state.sentinel ? 404 : state.status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  await fs.chmod(socket, 0o600);
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const dependencies = wired ? {} : undefined;
  const service = new TimeMachineService(
    { get: () => ({ dataDir: root }) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    {} as never,
    dependencies as never,
    dependencies as never,
    dependencies as never,
  );
  cleanup.push(() => service.onModuleDestroy());
  vi.stubEnv('ORBIS_HOST_SOCKET', socket);
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'linux' });
  return { root, socket, requests, state, service };
}

it.each([false, true])('advertises core capture only after read-only negotiation (sentinel=%s)', async (sentinel) => {
  const f = await fixture();
  f.state.sentinel = sentinel;
  expect((await f.service.capabilities()).manualCapture).toBe(true);
  expect(f.requests).toEqual([
    { method: 'GET', url: '/v1/core-captures/reserved-start-capability' },
    { method: 'GET', url: '/v1/core-captures/sentinel-start-capability' },
  ]);
  expect(await fs.readdir(f.root)).toEqual(['s']);
});

it.each(['missing-socket', 'missing-producers', 'unsupported-platform', 'closing'])('does not advertise capture with %s', async (reason) => {
  const f = await fixture(reason !== 'missing-producers');
  if (reason === 'missing-socket') vi.stubEnv('ORBIS_HOST_SOCKET', '');
  if (reason === 'unsupported-platform') Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' });
  if (reason === 'closing') await f.service.onModuleDestroy();
  const result = await f.service.capabilities();
  expect(result.manualCapture).toBe(false);
  expect(result.restore.supported).toBe(false);
  expect(f.requests).toEqual([]);
});

it.each(['older-helper', 'changed-protocol', 'insecure-socket', 'disconnected'])(
  'keeps capture unavailable for %s and recovers when support returns',
  async (reason) => {
    const f = await fixture();
    if (reason === 'older-helper') f.state.status = 404;
    if (reason === 'changed-protocol') f.state.value = { ...coreCaptureReservedStartCapability, admissionReplay: 'allowed' };
    if (reason === 'insecure-socket') await fs.chmod(f.socket, 0o660);
    if (reason === 'disconnected') vi.stubEnv('ORBIS_HOST_SOCKET', path.join(f.root, 'absent'));
    expect((await f.service.capabilities()).manualCapture).toBe(false);
    f.state.status = 200;
    f.state.value = coreCaptureReservedStartCapability;
    await fs.chmod(f.socket, 0o600);
    vi.stubEnv('ORBIS_HOST_SOCKET', f.socket);
    expect((await f.service.capabilities()).manualCapture).toBe(true);
    expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  },
);

it('bounds a silent helper without blocking access to capabilities indefinitely', async () => {
  const f = await fixture();
  f.state.hang = true;
  expect((await f.service.capabilities()).manualCapture).toBe(false);
  expect(f.requests).toEqual([{ method: 'GET', url: '/v1/core-captures/reserved-start-capability' }]);
});
