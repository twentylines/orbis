import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HostCoreCaptureReservationObserver } from './host-core-capture-reservation-observer';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ro-'));
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
  const state = { value: expected as unknown, status: 200, drop: false, beforeReply: undefined as (() => Promise<void>) | undefined };
  const requests: { method: string | undefined; route: string | undefined; body: unknown }[] = [];
  const server = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    requests.push({ method: req.method, route: req.url, body: JSON.parse(Buffer.concat(parts).toString()) });
    if (state.drop) {
      req.socket.destroy();
      return;
    }
    await state.beforeReply?.();
    const bytes = Buffer.from(JSON.stringify(state.value));
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
  return { root, socket, state, requests, expected, observer: new HostCoreCaptureReservationObserver(socket) };
}

it('observes the exact existing reservation without submitting a prepare or admission command', async () => {
  const f = await fixture();
  const result = await f.observer.observe(f.expected.id, f.expected.pointReservationSha256, signal());
  expect(result).toEqual(f.expected);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.controller)).toBe(true);
  expect(f.requests).toEqual([
    { method: 'POST', route: `/v1/core-captures/${f.expected.id}/preparation`, body: { pointReservationSha256: f.expected.pointReservationSha256 } },
  ]);
});

it('does not send malformed point or reservation identities', async () => {
  const f = await fixture();
  await expect(f.observer.observe('../point', f.expected.pointReservationSha256, signal())).rejects.toThrow();
  await expect(f.observer.observe(f.expected.id, 'C'.repeat(64), signal())).rejects.toThrow();
  expect(f.requests).toHaveLength(0);
});

it('rejects another point, another saved reservation, legacy version or extra authority fields', async () => {
  const f = await fixture();
  for (const value of [
    { ...f.expected, id: '22222222-2222-4222-8222-222222222222' },
    { ...f.expected, pointReservationSha256: '0'.repeat(64) },
    { ...f.expected, version: 2 },
    { ...f.expected, complete: true },
    { ...f.expected, controller: { ...f.expected.controller, id: 'D'.repeat(64) } },
  ]) {
    f.state.value = value;
    await expect(f.observer.observe(f.expected.id, f.expected.pointReservationSha256, signal())).rejects.toThrow();
  }
  expect(f.requests.every((request) => request.route?.endsWith('/preparation'))).toBe(true);
});

it('does not retry a lost observation response or turn unavailable authority into success', async () => {
  const f = await fixture();
  f.state.drop = true;
  await expect(f.observer.observe(f.expected.id, f.expected.pointReservationSha256, signal())).rejects.toThrow();
  expect(f.requests).toHaveLength(1);
  f.state.drop = false;
  f.state.status = 409;
  await expect(f.observer.observe(f.expected.id, f.expected.pointReservationSha256, signal())).rejects.toThrow();
  expect(f.requests).toHaveLength(2);
});

it('rejects a socket replacement before accepting observation metadata', async () => {
  const f = await fixture();
  const replacement = http.createServer();
  f.state.beforeReply = async () => {
    await fs.rename(f.socket, path.join(f.root, 'original-socket'));
    await new Promise<void>((resolve, reject) => {
      replacement.once('error', reject);
      replacement.listen(f.socket, resolve);
    });
    await fs.chmod(f.socket, 0o600);
  };
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        replacement.closeAllConnections();
        replacement.close(() => resolve());
      }),
  );
  await expect(f.observer.observe(f.expected.id, f.expected.pointReservationSha256, signal())).rejects.toThrow();
  expect(f.requests).toHaveLength(1);
});
