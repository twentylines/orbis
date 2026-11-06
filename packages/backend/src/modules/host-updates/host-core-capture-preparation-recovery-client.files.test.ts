import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { coreCapturePreparationRecoveryCapability, HostCoreCapturePreparationRecoveryClient } from './host-core-capture-preparation-recovery-client';
import { HostCoreCaptureReservationObserver } from './host-core-capture-reservation-observer';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;

async function fixture() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'pr-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const socket = path.join(root, 's');
  const expected = {
    version: 3,
    id: '11111111-1111-4111-8111-111111111111',
    preparationSha256: 'a'.repeat(64),
    sourceSha256: 'b'.repeat(64),
    pointReservationSha256: 'c'.repeat(64),
    controller: { id: 'd'.repeat(64), imageId: `sha256:${'e'.repeat(64)}`, startedAt: '2026-11-06T00:00:00Z', definitionSha256: 'f'.repeat(64) },
  };
  const state = { capability: coreCapturePreparationRecoveryCapability as unknown, value: expected as unknown, status: 200, drop: false };
  const requests: { method: string | undefined; route: string | undefined; body?: unknown }[] = [];
  const server = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    requests.push({ method: req.method, route: req.url, ...(parts.length ? { body: JSON.parse(Buffer.concat(parts).toString()) } : {}) });
    const capability = req.url?.endsWith('/preparation-recovery-capability');
    if (!capability && state.drop) {
      req.socket.destroy();
      return;
    }
    const bytes = Buffer.from(JSON.stringify(capability ? state.capability : state.value));
    res.writeHead(state.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': bytes.length });
    res.end(bytes);
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
  return { socket, state, requests, expected, client: new HostCoreCapturePreparationRecoveryClient(socket) };
}

it('negotiates recovery independently of legacy capture start and submits one exact original point', async () => {
  const f = await fixture();
  const result = await f.client.reconcile(f.expected.id, f.expected.pointReservationSha256, signal());
  expect(result).toEqual(f.expected);
  expect(Object.isFrozen(result)).toBe(true);
  expect(f.requests).toEqual([
    { method: 'GET', route: '/v1/core-captures/preparation-recovery-capability' },
    {
      method: 'POST',
      route: `/v1/core-captures/${f.expected.id}/reconcile-preparation`,
      body: { pointReservationSha256: f.expected.pointReservationSha256 },
    },
  ]);
  await expect(f.client.reconcile(f.expected.id, f.expected.pointReservationSha256, signal())).rejects.toThrow();
  expect(f.requests).toHaveLength(2);
});

it('never submits recovery to an unsupported older helper', async () => {
  const f = await fixture();
  for (const capability of [
    null,
    { ...coreCapturePreparationRecoveryCapability, preparationVersion: 2 },
    { ...coreCapturePreparationRecoveryCapability, extra: true },
  ]) {
    f.state.capability = capability;
    await expect(
      new HostCoreCapturePreparationRecoveryClient(f.socket).reconcile(f.expected.id, f.expected.pointReservationSha256, signal()),
    ).rejects.toThrow();
  }
  expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
});

it('allows the same client to recover after a capability check failed before any submission', async () => {
  const f = await fixture();
  f.state.status = 503;
  await expect(f.client.reconcile(f.expected.id, f.expected.pointReservationSha256, signal())).rejects.toThrow();
  expect(f.requests).toHaveLength(1);
  f.state.status = 200;
  expect(await f.client.reconcile(f.expected.id, f.expected.pointReservationSha256, signal())).toEqual(f.expected);
  expect(f.requests.map((request) => request.method)).toEqual(['GET', 'GET', 'POST']);
});

it('submits at most once when callers race through capability checking', async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    f.client.reconcile(f.expected.id, f.expected.pointReservationSha256, signal()),
    f.client.reconcile(f.expected.id, f.expected.pointReservationSha256, signal()),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(f.requests.filter((request) => request.method === 'POST')).toHaveLength(1);
});

it('does not send malformed identities or a pre-cancelled request', async () => {
  const f = await fixture();
  await expect(f.client.reconcile('../point', f.expected.pointReservationSha256, signal())).rejects.toThrow();
  await expect(f.client.reconcile(f.expected.id, 'C'.repeat(64), signal())).rejects.toThrow();
  await expect(f.client.reconcile(f.expected.id, f.expected.pointReservationSha256, AbortSignal.abort())).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
});

it('uses read-only observation after a lost reconciliation reply, without submitting again', async () => {
  const f = await fixture();
  f.state.drop = true;
  await expect(f.client.reconcile(f.expected.id, f.expected.pointReservationSha256, signal())).rejects.toThrow();
  await expect(f.client.reconcile(f.expected.id, f.expected.pointReservationSha256, signal())).rejects.toThrow();
  expect(f.requests).toHaveLength(2);
  f.state.drop = false;
  expect(await new HostCoreCaptureReservationObserver(f.socket).observe(f.expected.id, f.expected.pointReservationSha256, signal())).toEqual(
    f.expected,
  );
  expect(f.requests.at(-1)?.route).toBe(`/v1/core-captures/${f.expected.id}/preparation`);
});

it('rejects changed point bindings, legacy preparations and added authority fields', async () => {
  const f = await fixture();
  for (const value of [
    { ...f.expected, id: '22222222-2222-4222-8222-222222222222' },
    { ...f.expected, pointReservationSha256: '0'.repeat(64) },
    { ...f.expected, version: 2 },
    { ...f.expected, complete: true },
  ]) {
    f.state.value = value;
    await expect(
      new HostCoreCapturePreparationRecoveryClient(f.socket).reconcile(f.expected.id, f.expected.pointReservationSha256, signal()),
    ).rejects.toThrow();
  }
});

it('does not interpret a refused reconciliation as completion', async () => {
  const f = await fixture();
  f.state.status = 409;
  await expect(f.client.reconcile(f.expected.id, f.expected.pointReservationSha256, signal())).rejects.toThrow();
  expect(f.requests).toHaveLength(1);
});
