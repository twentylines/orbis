import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  coreCaptureRefusedAbortCapability,
  HostCoreCaptureRefusedAbortClient,
  HostCoreCaptureSetupAbortClient,
  HostCoreCaptureUnusedAbortClient,
} from './host-core-capture-unused-abort-client';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ro-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const socket = path.join(root, 's');
  const preparation = {
    version: 3 as const,
    id: '11111111-1111-4111-8111-111111111111',
    preparationSha256: 'a'.repeat(64),
    sourceSha256: 'b'.repeat(64),
    pointReservationSha256: 'c'.repeat(64),
    controller: { id: 'd'.repeat(64), imageId: `sha256:${'e'.repeat(64)}`, startedAt: '2026-11-06T00:00:00Z', definitionSha256: 'f'.repeat(64) },
  };
  const expected = {
    ...preparation,
    state: 'complete',
    sourceMarker: 'absent',
    sourceAttempt: 'not-started',
    decisionSha256: '0'.repeat(64),
    terminalSha256: '1'.repeat(64),
    commitSha256: '2'.repeat(64),
  };
  const state = {
    value: expected as unknown,
    capability: coreCaptureRefusedAbortCapability as unknown,
    status: 200,
    drop: false,
    beforeReply: undefined as (() => Promise<void>) | undefined,
  };
  const requests: { method: string | undefined; route: string | undefined; body: unknown }[] = [];
  const server = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const payload = Buffer.concat(parts);
    requests.push({ method: req.method, route: req.url, body: payload.length ? JSON.parse(payload.toString()) : undefined });
    if (state.drop) {
      req.socket.destroy();
      return;
    }
    await state.beforeReply?.();
    const bytes = Buffer.from(JSON.stringify(req.url?.endsWith('/refused-abort-capability') ? state.capability : state.value));
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
  return { root, socket, state, requests, expected, preparation, client: new HostCoreCaptureUnusedAbortClient(socket) };
}

it('settles once and observes only exact positive unused-source completion', async () => {
  const f = await fixture();
  const result = await f.client.settle(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal());
  expect(result).toEqual(f.expected);
  await expect(f.client.settle(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal())).rejects.toThrow();
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toEqual({
    method: 'POST',
    route: `/v1/core-captures/${f.preparation.id}/abort-unused-settle`,
    body: {
      preparationSha256: f.preparation.preparationSha256,
      decisionSha256: f.expected.decisionSha256,
      terminalSha256: f.expected.terminalSha256,
    },
  });
  await expect(f.client.status(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal())).resolves.toEqual(f.expected);
  expect(f.requests[1]?.route).toMatch(/abort-unused-status$/);
});

it('does not accept retained-drain versions, invented continuation or wrong source bindings', async () => {
  const f = await fixture();
  for (const value of [
    { ...f.expected, version: 2 },
    { ...f.expected, sourceAttempt: 'started' },
    { ...f.expected, sourceMarker: 'retired' },
    { ...f.expected, sourceSha256: '9'.repeat(64) },
    { ...f.expected, continuationSha256: '3'.repeat(64) },
    { ...f.expected, terminalSha256: '4'.repeat(64) },
  ]) {
    f.state.value = value;
    await expect(f.client.status(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal())).rejects.toThrow();
  }
});

it('does not retry a lost settle reply, and requires a positive status response', async () => {
  const f = await fixture();
  f.state.drop = true;
  await expect(f.client.settle(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal())).rejects.toThrow();
  await expect(f.client.settle(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal())).rejects.toThrow();
  expect(f.requests).toHaveLength(1);
  f.state.drop = false;
  f.state.status = 409;
  await expect(f.client.status(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal())).rejects.toThrow();
});

it('rejects malformed identities before contacting the host', async () => {
  const f = await fixture();
  await expect(f.client.settle({ ...f.preparation, id: '../bad' }, f.expected.decisionSha256, f.expected.terminalSha256, signal())).rejects.toThrow();
  await expect(f.client.settle(f.preparation, 'invalid', f.expected.terminalSha256, signal())).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
});

const setupComplete = (expected: Awaited<ReturnType<typeof fixture>>['expected']) => ({
  ...expected,
  version: 4,
  sourceAttempt: 'setup-unwound',
  localLease: 'not-acquired',
  queueUnwind: {
    pauseId: '22222222-2222-4222-8222-222222222222',
    generation: 7,
    queues: ['app-events-queue', 'repo-queue', 'system-events-queue'].map((name) => ({ name, messages: 0, consumers: 1 })),
  },
});

it('settles a positively unwound setup once using its separate v4 contract', async () => {
  const f = await fixture();
  const expected = setupComplete(f.expected);
  f.state.value = expected;
  const client = new HostCoreCaptureSetupAbortClient(f.socket);
  await expect(client.settle(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal())).resolves.toEqual(expected);
  await expect(client.settle(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal())).rejects.toThrow();
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.route).toMatch(/abort-setup-settle$/);
  await expect(client.status(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal())).resolves.toEqual(expected);
  expect(f.requests[1]?.route).toMatch(/abort-setup-status$/);
  await expect(f.client.status(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal())).rejects.toThrow();
});

it('refuses missing, forged, non-idle or downgraded setup-unwind responses', async () => {
  const f = await fixture();
  const expected = setupComplete(f.expected);
  const client = new HostCoreCaptureSetupAbortClient(f.socket);
  for (const value of [
    f.expected,
    { ...expected, version: 3 },
    { ...expected, localLease: 'acquired' },
    { ...expected, queueUnwind: undefined },
    { ...expected, queueUnwind: { ...expected.queueUnwind, generation: true } },
    { ...expected, queueUnwind: { ...expected.queueUnwind, generation: 0 } },
    { ...expected, queueUnwind: { ...expected.queueUnwind, queues: [] } },
    { ...expected, queueUnwind: { ...expected.queueUnwind, queues: expected.queueUnwind.queues.map((row) => ({ ...row, messages: 1 })) } },
    { ...expected, queueUnwind: { ...expected.queueUnwind, queues: expected.queueUnwind.queues.map((row) => ({ ...row, consumers: 0 })) } },
    { ...expected, queueUnwind: { ...expected.queueUnwind, queues: Array(3).fill(expected.queueUnwind.queues[0]) } },
  ]) {
    f.state.value = value;
    await expect(client.status(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal())).rejects.toThrow();
  }
});

it('requires explicit refusal support without submitting commands to an older helper', async () => {
  const f = await fixture();
  const client = new HostCoreCaptureRefusedAbortClient(f.socket);
  for (const capability of [
    null,
    { ...coreCaptureRefusedAbortCapability, terminalVersion: 4 },
    { ...coreCaptureRefusedAbortCapability, extra: true },
  ]) {
    f.state.capability = capability;
    await expect(client.requireCapability(signal())).rejects.toThrow();
  }
  expect(f.requests.every((request) => request.method === 'GET')).toBe(true);
  f.state.capability = coreCaptureRefusedAbortCapability;
  expect(typeof (await client.requireCapability(signal()))).toBe('string');
});

it('keeps the refused setup v5 separate from unused and owned-unwind settlement', async () => {
  const f = await fixture();
  const expected = {
    ...f.expected,
    version: 5,
    sourceAttempt: 'setup-refused',
    localLease: 'not-acquired',
    queueRefusal: {
      setupId: '33333333-3333-4333-8333-333333333333',
      outcome: 'not-entered',
      generation: 1,
      queues: ['app-events-queue', 'repo-queue', 'system-events-queue'].map((name) => ({ name, messages: 0, consumers: 1 })),
    },
  };
  f.state.value = expected;
  const client = new HostCoreCaptureRefusedAbortClient(f.socket);
  expect(await client.settle(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal())).toEqual(expected);
  await expect(client.settle(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal())).rejects.toThrow();
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.route).toMatch(/abort-refused-settle$/);
  expect(await client.status(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal())).toEqual(expected);
  await expect(
    new HostCoreCaptureSetupAbortClient(f.socket).status(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal()),
  ).rejects.toThrow();
  for (const queueRefusal of [
    { ...expected.queueRefusal, outcome: 'owned' },
    { ...expected.queueRefusal, setupId: 'bad' },
    { ...expected.queueRefusal, generation: true },
    { ...expected.queueRefusal, extra: true },
    { ...expected.queueRefusal, queues: expected.queueRefusal.queues.map((row) => ({ ...row, consumers: 0 })) },
  ]) {
    f.state.value = { ...expected, queueRefusal };
    await expect(client.status(f.preparation, f.expected.decisionSha256, f.expected.terminalSha256, signal())).rejects.toThrow();
  }
});
