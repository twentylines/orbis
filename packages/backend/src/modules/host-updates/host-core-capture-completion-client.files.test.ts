import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { HostCoreCaptureCompletionClient, useVerifiedCoreCompletion, type VerifiedCoreCompletion } from './host-core-capture-completion-client';

vi.unmock('fs');
vi.unmock('node:fs');
vi.unmock('fs/promises');
vi.unmock('node:fs/promises');
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const h = (v: string) => v.repeat(64);
const binding = { id: '12345678-1234-4234-8234-123456789abc', sourceSha256: h('a'), sourceHoldSha256: h('b') };
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(process.env.ORBIS_CORE_CAPTURE_TEST_DIR ?? os.tmpdir()), 'cc-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const socket = path.join(root, 's');
  const ready = {
    version: 1,
    ...binding,
    state: 'verified-awaiting-continuation',
    completionSha256: h('c'),
    pointReservationSha256: h('d'),
    controller: { id: h('e'), imageId: `sha256:${h('f')}`, startedAt: '2026-11-06T00:00:00Z', definitionSha256: h('0') },
  };
  const state = {
    reply: ready as unknown,
    type: 'application/json',
    cache: 'no-store',
    length: 0,
    encoding: '',
    requests: [] as { path: string; body: unknown }[],
    afterReply: async () => {},
  };
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    state.requests.push({ path: request.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString()) });
    const body = JSON.stringify(state.reply);
    response.writeHead(200, {
      'Content-Type': state.type,
      'Cache-Control': state.cache,
      'Content-Length': state.length || Buffer.byteLength(body),
      ...(state.encoding ? { 'Content-Encoding': state.encoding } : {}),
    });
    await state.afterReply();
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  await fs.chmod(socket, 0o600);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { root, socket, ready, state, client: new HostCoreCaptureCompletionClient(socket) };
}

it('mints detached frozen single-use grants from an exact socket response', async () => {
  const f = await fixture();
  const token = await f.client.prepare(binding, signal());
  await useVerifiedCoreCompletion(token, async (details) => {
    expect(details).toEqual(f.ready);
    expect(Object.isFrozen(details)).toBe(true);
    expect(Object.isFrozen(details.controller)).toBe(true);
    expect(details).not.toBe(f.ready);
  });
  await expect(useVerifiedCoreCompletion(token, async () => undefined)).rejects.toThrow();
  await expect(useVerifiedCoreCompletion({} as VerifiedCoreCompletion, async () => undefined)).rejects.toThrow();
  expect(f.state.requests).toEqual([
    { path: `/v1/core-captures/${binding.id}/completion`, body: { sourceSha256: h('a'), sourceHoldSha256: h('b') } },
  ]);
});

it('requires exact completed hashes and supports re-reading completion after a lost finish reply', async () => {
  const f = await fixture();
  await expect(f.client.finish(binding, h('c'), h('1'), signal())).rejects.toThrow();
  f.state.reply = { ...f.ready, state: 'complete', continuationSha256: h('1') };
  const finished = await f.client.finish(binding, h('c'), h('1'), signal());
  await useVerifiedCoreCompletion(finished, async (d) => expect(d.state).toBe('complete'));
  const reread = await f.client.prepare(binding, signal());
  await useVerifiedCoreCompletion(reread, async (d) => expect(d.continuationSha256).toBe(h('1')));
  await expect(f.client.finish(binding, h('2'), h('1'), signal())).rejects.toThrow();
  expect(f.state.requests[1]?.body).toEqual({ sourceSha256: h('a'), sourceHoldSha256: h('b'), completionSha256: h('c'), continuationSha256: h('1') });
});

it.each(['extra', 'controller', 'state', 'binding', 'type', 'cache', 'encoding', 'length', 'oversize'] as const)(
  'rejects malformed %s replies',
  async (mode) => {
    const f = await fixture();
    if (mode === 'extra') f.state.reply = { ...f.ready, grant: true };
    if (mode === 'controller') f.state.reply = { ...f.ready, controller: { ...f.ready.controller, startedAt: '\n' } };
    if (mode === 'state') f.state.reply = { ...f.ready, state: 'reserved' };
    if (mode === 'binding') f.state.reply = { ...f.ready, id: randomUUID() };
    if (mode === 'type') f.state.type = 'application/json; charset=utf-8';
    if (mode === 'cache') f.state.cache = 'public';
    if (mode === 'encoding') f.state.encoding = 'identity';
    if (mode === 'length') f.state.length = 8193;
    if (mode === 'oversize') f.state.reply = { ...f.ready, extra: 'a'.repeat(8192) };
    await expect(f.client.prepare(binding, signal())).rejects.toThrow();
  },
);

it('pins the socket before minting and before and after consuming a grant', async () => {
  const f = await fixture();
  const token = await f.client.prepare(binding, signal());
  await fs.rename(f.socket, `${f.socket}.retained`);
  await expect(useVerifiedCoreCompletion(token, async () => undefined)).rejects.toThrow();
  await fs.rename(`${f.socket}.retained`, f.socket);
  const next = await f.client.prepare(binding, signal());
  await expect(
    useVerifiedCoreCompletion(next, async () => {
      await fs.chmod(f.socket, 0o400);
    }),
  ).rejects.toThrow();
  await fs.chmod(f.socket, 0o600);
  f.state.afterReply = async () => {
    await fs.chmod(f.socket, 0o400);
  };
  await expect(f.client.prepare(binding, signal())).rejects.toThrow();
});

it('does not mint on cancellation or an unsafe endpoint', async () => {
  const f = await fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(f.client.prepare(binding, abort.signal)).rejects.toThrow();
  await fs.chmod(f.socket, 0o666);
  await expect(f.client.prepare(binding, signal())).rejects.toThrow();
});

it('rejects a replaced socket even when its path and permissions match', async () => {
  const f = await fixture();
  const token = await f.client.prepare(binding, signal());
  await fs.rename(f.socket, `${f.socket}.retained`);
  const replacement = http.createServer();
  await new Promise<void>((resolve, reject) => {
    replacement.once('error', reject);
    replacement.listen(f.socket, resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        replacement.closeAllConnections();
        replacement.close(() => resolve());
      }),
  );
  await fs.chmod(f.socket, 0o600);
  const work = vi.fn(async () => undefined);
  await expect(useVerifiedCoreCompletion(token, work)).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
});

it('rejects truncated HTTP bodies before granting completion', async () => {
  const f = await fixture();
  f.state.length = Buffer.byteLength(JSON.stringify(f.ready)) + 1;
  await expect(f.client.prepare(binding, signal())).rejects.toThrow();
});
it('does not report a vanished post-response socket as a reconnectable transport error', async () => {
  const f = await fixture();
  f.state.afterReply = async () => fs.rename(f.socket, `${f.socket}.retained`);
  const error = await f.client.prepare(binding, signal()).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toHaveProperty('code');
});
