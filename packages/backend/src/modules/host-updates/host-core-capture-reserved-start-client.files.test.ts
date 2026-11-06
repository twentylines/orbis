import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { coreCapturePreparationRecoveryCapability } from './host-core-capture-preparation-recovery-client';
import { HostCoreCaptureReservedStartClient, coreCaptureReservedStartCapability } from './host-core-capture-reserved-start-client';
import { coreCaptureHostRequest, coreCaptureSentinelStartCapability } from './host-core-capture-start-client';

const point = '11111111-1111-4111-8111-111111111111';
const h = (value: string) => value.repeat(64);
const signal = () => new AbortController().signal;
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(process.env.ORBIS_CORE_SOCKET_TEST_DIR ?? os.tmpdir()), 'rs-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const socket = path.join(root, 's');
  const preparation = {
    version: 3,
    id: point,
    preparationSha256: h('a'),
    sourceSha256: h('b'),
    pointReservationSha256: h('c'),
    controller: { id: h('d'), imageId: `sha256:${h('e')}`, startedAt: '2026-11-06T00:00:00Z', definitionSha256: h('f') },
  };
  const state = {
    capability: coreCaptureReservedStartCapability as unknown,
    capabilityStatus: 200,
    sentinelCapability: { ...coreCaptureSentinelStartCapability, available: true } as unknown,
    sentinelStatus: 404,
    preparation: preparation as unknown,
    lostPrepare: false,
    observationStatus: 200,
    observationError: { error: 'Not prepared' } as unknown,
    observationType: 'application/json',
    recoveryCapability: coreCapturePreparationRecoveryCapability as unknown,
    recoveryStatus: 200,
    admissionStatus: 200,
    calls: [] as { path: string; method: string; body: unknown }[],
  };
  const server = http.createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const raw of request) parts.push(Buffer.from(raw));
    const bytes = Buffer.concat(parts);
    const route = request.url ?? '';
    state.calls.push({ path: route, method: request.method ?? '', body: bytes.length ? JSON.parse(bytes.toString()) : undefined });
    if (route.includes('/prepare-reserved') && state.lostPrepare) {
      request.socket.destroy();
      return;
    }
    let status = 200;
    let value: unknown;
    if (route.endsWith('/reserved-start-capability')) {
      status = state.capabilityStatus;
      value = state.capability;
    } else if (route.endsWith('/sentinel-start-capability')) {
      status = state.sentinelStatus;
      value = status === 404 ? { error: 'Not found' } : state.sentinelCapability;
    } else if (route.endsWith('/preparation-recovery-capability')) value = state.recoveryCapability;
    else if (route.endsWith('/preparation')) {
      status = state.observationStatus;
      value = status === 200 ? state.preparation : state.observationError;
    } else if (route.endsWith('/reconcile-preparation')) {
      status = state.recoveryStatus;
      value = status === 200 ? state.preparation : { error: 'Unsettled' };
    } else if (route.endsWith('/admit')) {
      status = state.admissionStatus;
      value = { version: 1, id: point, state: 'launch-requested', sourceHoldSha256: h('0') };
    } else value = state.preparation;
    const payload = Buffer.from(JSON.stringify(value));
    response.writeHead(status, {
      'Content-Type': route.endsWith('/preparation') ? state.observationType : 'application/json',
      'Cache-Control': 'no-store',
      'Content-Length': payload.length,
    });
    response.end(payload);
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
  return { state, preparation, socket, client: new HostCoreCaptureReservedStartClient(socket) };
}

it.each([404, 200])('requires the exact reserved capability without falling back (status=%s)', async (status) => {
  const f = await fixture();
  f.state.capabilityStatus = status;
  f.state.capability = status === 404 ? { error: 'Not found' } : { ...coreCaptureReservedStartCapability, preparationVersion: 2 };
  await expect(f.client.requireCapability(signal())).rejects.toThrow();
  await expect(f.client.prepare(point, h('c'), signal())).rejects.toThrow();
  expect(f.state.calls.map((call) => call.path)).toEqual(['/v1/core-captures/reserved-start-capability']);
});

it.each([404, false, true])('selects only negotiated reserved publication (%s)', async (available) => {
  const f = await fixture();
  if (available !== 404) {
    f.state.sentinelStatus = 200;
    f.state.sentinelCapability = { ...coreCaptureSentinelStartCapability, available };
  }
  await f.client.requireCapability(signal());
  const approved = await f.client.prepare(point, h('c'), signal());
  expect(approved.preparation).toEqual(f.preparation);
  expect(Object.isFrozen(approved.preparation.controller)).toBe(true);
  expect(approved.publisher).toBe(available === true ? 'sentinel.v1' : 'controller-restart.v1');
  expect(f.state.calls[2]).toEqual({
    path: `/v1/core-captures/${point}/prepare-reserved${available === true ? '-sentinel' : ''}`,
    method: 'POST',
    body: {},
  });
  await f.client.admit(approved.token, h('0'), signal());
  await expect(f.client.admit(approved.token, h('0'), signal())).rejects.toThrow();
  await expect(f.client.prepare(point, h('c'), signal())).rejects.toThrow();
  expect(f.state.calls.filter((call) => call.path.endsWith('/admit'))).toHaveLength(1);
});

it('rejects malformed sentinel support before any preparation', async () => {
  const f = await fixture();
  f.state.sentinelStatus = 200;
  f.state.sentinelCapability = { ...coreCaptureSentinelStartCapability, available: true, unexpected: true };
  await expect(f.client.requireCapability(signal())).rejects.toThrow();
  await expect(f.client.prepare(point, h('c'), signal())).rejects.toThrow();
  expect(f.state.calls).toHaveLength(2);
});

it.each([200, 409])('observes or reconciles the original lost reservation without preparing again (%s)', async (observationStatus) => {
  const f = await fixture();
  await f.client.requireCapability(signal());
  f.state.lostPrepare = true;
  f.state.observationStatus = observationStatus;
  const approved = await f.client.prepare(point, h('c'), signal());
  expect(approved.preparation).toEqual(f.preparation);
  expect(f.state.calls.filter((call) => call.path.includes('/prepare-reserved'))).toHaveLength(1);
  expect(f.state.calls.filter((call) => call.path.endsWith('/reconcile-preparation'))).toHaveLength(observationStatus === 409 ? 1 : 0);
  for (const call of f.state.calls.filter((call) => call.path.endsWith('/preparation') || call.path.endsWith('/reconcile-preparation')))
    expect(call.body).toEqual({ pointReservationSha256: h('c') });
  await expect(f.client.prepare(point, h('c'), signal())).rejects.toThrow();
});

it('retains uncertainty if lost preparation cannot be reconciled', async () => {
  const f = await fixture();
  await f.client.requireCapability(signal());
  f.state.lostPrepare = true;
  f.state.observationStatus = 409;
  f.state.recoveryStatus = 409;
  await expect(f.client.prepare(point, h('c'), signal())).rejects.toThrow();
  await expect(f.client.prepare(point, h('c'), signal())).rejects.toThrow();
  expect(f.state.calls.filter((call) => call.path.includes('/prepare-reserved'))).toHaveLength(1);
  expect(f.state.calls.filter((call) => call.path.endsWith('/reconcile-preparation'))).toHaveLength(1);
});

it('rejects mismatched preparation without converting it into recovery or admission authority', async () => {
  const f = await fixture();
  await f.client.requireCapability(signal());
  f.state.preparation = { ...f.preparation, pointReservationSha256: h('9') };
  await expect(f.client.prepare(point, h('c'), signal())).rejects.toThrow();
  expect(f.state.calls).toHaveLength(3);
});

it('consumes tokens on rejected admission and rejects tokens from another client', async () => {
  const f = await fixture();
  await f.client.requireCapability(signal());
  const approved = await f.client.prepare(point, h('c'), signal());
  await expect(new HostCoreCaptureReservedStartClient(f.socket).admit(approved.token, h('0'), signal())).rejects.toThrow();
  f.state.admissionStatus = 409;
  await expect(f.client.admit(approved.token, h('0'), signal())).rejects.toThrow();
  await expect(f.client.admit(approved.token, h('0'), signal())).rejects.toThrow();
  expect(f.state.calls.filter((call) => call.path.endsWith('/admit'))).toHaveLength(1);
});

it.each(['invalid-hash', 'changed-socket'] as const)('consumes admission tokens before local validation (%s)', async (mode) => {
  const f = await fixture();
  await f.client.requireCapability(signal());
  const approved = await f.client.prepare(point, h('c'), signal());
  if (mode === 'changed-socket') await fs.chmod(f.socket, 0o666);
  await expect(f.client.admit(approved.token, mode === 'invalid-hash' ? 'invalid' : h('0'), signal())).rejects.toThrow();
  if (mode === 'changed-socket') await fs.chmod(f.socket, 0o600);
  await expect(f.client.admit(approved.token, h('0'), signal())).rejects.toThrow();
  expect(f.state.calls.filter((call) => call.path.endsWith('/admit'))).toHaveLength(0);
});

it('does not reconcile after an invalid recovery capability', async () => {
  const f = await fixture();
  await f.client.requireCapability(signal());
  f.state.lostPrepare = true;
  f.state.observationStatus = 409;
  f.state.recoveryCapability = { ...coreCapturePreparationRecoveryCapability, releasesCapture: true };
  await expect(f.client.prepare(point, h('c'), signal())).rejects.toThrow();
  expect(f.state.calls.filter((call) => call.path.endsWith('/reconcile-preparation'))).toHaveLength(0);
  expect(f.state.calls.filter((call) => call.path.includes('/prepare-reserved'))).toHaveLength(1);
});

it('requires the original negotiation socket before preparation', async () => {
  const f = await fixture();
  await f.client.requireCapability(signal());
  await fs.chmod(f.socket, 0o666);
  await expect(f.client.prepare(point, h('c'), signal())).rejects.toThrow();
  expect(f.state.calls).toHaveLength(2);
});

it('does not reconcile a malformed or mismatched successful observation', async () => {
  const f = await fixture();
  await f.client.requireCapability(signal());
  f.state.lostPrepare = true;
  f.state.preparation = { ...f.preparation, pointReservationSha256: h('9') };
  await expect(f.client.prepare(point, h('c'), signal())).rejects.toThrow();
  expect(f.state.calls.filter((call) => call.path.endsWith('/preparation'))).toHaveLength(1);
  expect(f.state.calls.filter((call) => call.path.endsWith('/reconcile-preparation'))).toHaveLength(0);
});

it.each(['missing', 'malformed-error', 'unsafe-header'] as const)('does not reconcile an untrusted preparation observation (%s)', async (mode) => {
  const f = await fixture();
  await f.client.requireCapability(signal());
  f.state.lostPrepare = true;
  f.state.observationStatus = mode === 'missing' ? 404 : 409;
  if (mode === 'malformed-error') f.state.observationError = { error: 'Not prepared', extra: true };
  if (mode === 'unsafe-header') f.state.observationType = 'text/plain';
  await expect(f.client.prepare(point, h('c'), signal())).rejects.toThrow();
  expect(f.state.calls.filter((call) => call.path.endsWith('/reconcile-preparation'))).toHaveLength(0);
});

it('never accepts conflict observation opt-in for another route', async () => {
  const f = await fixture();
  f.state.admissionStatus = 409;
  await expect(
    coreCaptureHostRequest(f.socket, `/v1/core-captures/${point}/admit`, {}, signal(), undefined, false, undefined, true),
  ).rejects.toThrow();
});
