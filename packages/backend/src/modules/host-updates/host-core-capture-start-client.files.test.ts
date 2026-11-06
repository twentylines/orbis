import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  HostCoreCaptureStartClient,
  coreCaptureStartCapability,
  coreCaptureSentinelStartCapability,
  coreCaptureHostRequest,
  type PreparedCoreCaptureStart,
} from './host-core-capture-start-client';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

it.each(['headers', 'body'] as const)('reports an internal deadline while waiting for %s as an observable transport timeout', async (stage) => {
  const f = await fixture();
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const waiting = Promise.withResolvers<void>();
  if (stage === 'headers')
    f.state.beforeHeaders = async () => {
      waiting.resolve();
      await new Promise(() => {});
    };
  else
    f.state.afterReply = async () => {
      waiting.resolve();
      await new Promise(() => {});
    };
  const request = coreCaptureHostRequest(f.socket, '/v1/core-captures/capabilities', undefined, signal());
  const failure = expect(request).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  await waiting.promise;
  deadline.abort(new DOMException('Internal deadline', 'TimeoutError'));
  await failure;
  expect(f.state.calls).toHaveLength(1);
});

it('keeps caller cancellation distinct even when the internal deadline also expires', async () => {
  const f = await fixture();
  const deadline = new AbortController();
  const caller = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const waiting = Promise.withResolvers<void>();
  f.state.beforeHeaders = async () => {
    waiting.resolve();
    await new Promise(() => {});
  };
  const request = coreCaptureHostRequest(f.socket, '/v1/core-captures/capabilities', undefined, caller.signal);
  const failure = expect(request).rejects.toMatchObject({ code: 'ABORT_ERR' });
  await waiting.promise;
  caller.abort();
  deadline.abort(new DOMException('Internal deadline', 'TimeoutError'));
  await failure;
  expect(f.state.calls).toHaveLength(1);
});
const point = '11111111-1111-4111-8111-111111111111';
const h = (v: string) => v.repeat(64);
const signal = () => new AbortController().signal;

it('refuses a different expected socket authority before sending a mutation', async () => {
  const f = await fixture();
  await expect(coreCaptureHostRequest(f.socket, `/v1/core-captures/${point}/prepare`, {}, signal(), 'different-authority')).rejects.toThrow();
  expect(f.state.calls).toHaveLength(0);
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(process.env.ORBIS_CORE_SOCKET_TEST_DIR ?? os.tmpdir()), 'sc-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const socket = path.join(root, 's');
  const preparation = {
    version: 2,
    id: point,
    preparationSha256: h('a'),
    sourceSha256: h('b'),
    pointReservationSha256: h('c'),
    controller: { id: h('d'), imageId: `sha256:${h('e')}`, startedAt: '2026-11-06T00:00:00Z', definitionSha256: h('f') },
  };
  const state = {
    capability: coreCaptureStartCapability as unknown,
    sentinelCapability: { ...coreCaptureSentinelStartCapability, available: true } as unknown,
    sentinelStatus: 404,
    preparation: preparation as unknown,
    admission: { version: 1, id: point, state: 'launch-requested', sourceHoldSha256: h('0') } as unknown,
    status: 200,
    encoding: '',
    type: 'application/json',
    cache: 'no-store',
    beforeHeaders: async () => {},
    afterReply: async () => {},
    calls: [] as { path: string; method: string; body: unknown }[],
  };
  const server = http.createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const raw of request) parts.push(Buffer.from(raw));
    const body = Buffer.concat(parts);
    state.calls.push({ path: request.url ?? '', method: request.method ?? '', body: body.length ? JSON.parse(body.toString()) : undefined });
    const optional = request.url?.endsWith('/sentinel-start-capability');
    const value = optional
      ? state.sentinelStatus === 404
        ? { error: 'Not found' }
        : state.sentinelCapability
      : request.method === 'GET'
        ? state.capability
        : request.url?.endsWith('/prepare') || request.url?.endsWith('/prepare-sentinel')
          ? state.preparation
          : state.admission;
    const bytes = Buffer.from(JSON.stringify(value));
    await state.beforeHeaders();
    response.writeHead(optional ? state.sentinelStatus : state.status, {
      'Content-Type': state.type,
      'Cache-Control': state.cache,
      'Content-Length': bytes.length,
      ...(state.encoding ? { 'Content-Encoding': state.encoding } : {}),
    });
    response.flushHeaders();
    await state.afterReply();
    response.end(bytes);
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
  return { state, preparation, socket, client: new HostCoreCaptureStartClient(socket) };
}

it('negotiates optional support and binds a single admission to the original reservation', async () => {
  const f = await fixture();
  await f.client.requireCapability(signal());
  const ready = await f.client.prepare(point, h('c'), signal());
  expect(ready.preparation).toEqual(f.preparation);
  expect(Object.isFrozen(ready.preparation.controller)).toBe(true);
  const result = await f.client.admit(ready.token, h('0'), signal());
  expect(result.state).toBe('launch-requested');
  await expect(f.client.admit(ready.token, h('0'), signal())).rejects.toThrow();
  expect(f.state.calls).toEqual([
    { path: '/v1/core-captures/capabilities', method: 'GET', body: undefined },
    { path: '/v1/core-captures/sentinel-start-capability', method: 'GET', body: undefined },
    { path: `/v1/core-captures/${point}/prepare`, method: 'POST', body: {} },
    { path: `/v1/core-captures/${point}/admit`, method: 'POST', body: { preparationSha256: h('a'), sourceHoldSha256: h('0') } },
  ]);
});

it('selects Sentinel only from its explicit available contract, without changing the old capability', async () => {
  const f = await fixture();
  f.state.sentinelStatus = 200;
  await f.client.requireCapability(signal());
  const ready = await f.client.prepare(point, h('c'), signal());
  expect(ready.publisher).toBe('sentinel.v1');
  expect(f.state.calls.at(-1)?.path).toBe(`/v1/core-captures/${point}/prepare-sentinel`);
  await f.client.admit(ready.token, h('0'), signal());
  expect(f.state.calls.at(-1)?.path).toBe(`/v1/core-captures/${point}/admit`);
});

it('keeps the supported old path for an explicitly unavailable Sentinel', async () => {
  const f = await fixture();
  f.state.sentinelStatus = 200;
  f.state.sentinelCapability = { ...coreCaptureSentinelStartCapability, available: false };
  await f.client.requireCapability(signal());
  expect((await f.client.prepare(point, h('c'), signal())).publisher).toBe('controller-restart.v1');
  expect(f.state.calls.at(-1)?.path).toBe(`/v1/core-captures/${point}/prepare`);
});

it.each([503, 200])('does not fall back after an invalid optional capability (%s)', async (status) => {
  const f = await fixture();
  f.state.sentinelStatus = status;
  f.state.sentinelCapability = { ...coreCaptureSentinelStartCapability, available: 'yes' };
  await expect(f.client.requireCapability(signal())).rejects.toThrow();
  expect(f.state.calls.every((call) => call.method === 'GET')).toBe(true);
});

it.each(['capability', 'binding', 'extra', 'controller'] as const)('rejects a changed %s contract', async (mode) => {
  const f = await fixture();
  if (mode === 'capability') {
    f.state.capability = { ...coreCaptureStartCapability, admissionReplay: 'allowed' };
    await expect(f.client.requireCapability(signal())).rejects.toThrow();
  } else {
    f.state.preparation =
      mode === 'binding'
        ? { ...f.preparation, pointReservationSha256: h('9') }
        : mode === 'extra'
          ? { ...f.preparation, execute: true }
          : { ...f.preparation, controller: { ...f.preparation.controller, id: '../controller' } };
    await expect(f.client.prepare(point, h('c'), signal())).rejects.toThrow();
  }
  expect(f.state.calls.some((call) => call.path.endsWith('/admit'))).toBe(false);
});

it('does not accept forged or another client’s admission tokens', async () => {
  const f = await fixture();
  await expect(f.client.admit({} as PreparedCoreCaptureStart, h('0'), signal())).rejects.toThrow();
  const ready = await f.client.prepare(point, h('c'), signal());
  await expect(new HostCoreCaptureStartClient(f.socket).admit(ready.token, h('0'), signal())).rejects.toThrow();
  expect(f.state.calls).toHaveLength(1);
});

it('consumes a submitted token even when the reply reports an unsettled or failed launch', async () => {
  const f = await fixture();
  let ready = await f.client.prepare(point, h('c'), signal());
  f.state.admission = { version: 1, id: point, state: 'launch-unsettled', sourceHoldSha256: h('0') };
  expect((await f.client.admit(ready.token, h('0'), signal())).state).toBe('launch-unsettled');
  ready = await f.client.prepare(point, h('c'), signal());
  f.state.status = 409;
  await expect(f.client.admit(ready.token, h('0'), signal())).rejects.toThrow();
  const calls = f.state.calls.length;
  await expect(f.client.admit(ready.token, h('0'), signal())).rejects.toThrow();
  expect(f.state.calls).toHaveLength(calls);
});

it.each(['type', 'cache', 'encoding', 'status'] as const)('refuses unsafe response %s', async (mode) => {
  const f = await fixture();
  if (mode === 'type') f.state.type = 'text/plain';
  if (mode === 'cache') f.state.cache = 'public';
  if (mode === 'encoding') f.state.encoding = 'gzip';
  if (mode === 'status') f.state.status = 404;
  await expect(f.client.requireCapability(signal())).rejects.toThrow();
});

it('pins the socket throughout preparation and again before submission', async () => {
  const f = await fixture();
  const ready = await f.client.prepare(point, h('c'), signal());
  await fs.chmod(f.socket, 0o666);
  await expect(f.client.admit(ready.token, h('0'), signal())).rejects.toThrow();
  expect(f.state.calls).toHaveLength(1);
  await fs.chmod(f.socket, 0o600);
  f.state.afterReply = async () => fs.rename(f.socket, `${f.socket}.retained`);
  const error = await f.client.prepare(point, h('c'), signal()).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toHaveProperty('code');
});

it('rejects invalid identifiers and cancelled setup before sending a request', async () => {
  const f = await fixture();
  await expect(f.client.prepare('../point', h('c'), signal())).rejects.toThrow();
  const cancellation = new AbortController();
  cancellation.abort();
  await expect(f.client.requireCapability(cancellation.signal)).rejects.toThrow();
  expect(f.state.calls).toEqual([]);
});
