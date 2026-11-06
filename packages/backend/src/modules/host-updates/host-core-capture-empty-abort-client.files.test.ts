import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  HostCoreCaptureEmptyAbortClient,
  useVerifiedCoreEmptyAbortApproval,
  useVerifiedCoreEmptyAbortComplete,
  type VerifiedCoreEmptyAbortComplete,
} from './host-core-capture-empty-abort-client';
import type { CoreCaptureAbortPreparation } from './host-core-capture-abort-client';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const h = (s: string) => s.repeat(64);
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ea-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const socket = path.join(root, 's');
  const preparation: CoreCaptureAbortPreparation = {
    version: 3,
    id: '11111111-1111-4111-8111-111111111111',
    preparationSha256: h('a'),
    sourceSha256: h('b'),
    pointReservationSha256: h('c'),
    controller: { id: h('d'), imageId: `sha256:${h('e')}`, startedAt: '2026-11-06T00:00:00Z', definitionSha256: h('f') },
  };
  const approval = {
    version: 2,
    id: preparation.id,
    state: 'verified-abort-awaiting-continuation',
    sourceMarker: 'absent',
    preparationSha256: h('a'),
    sourceSha256: h('b'),
    pointReservationSha256: h('c'),
    controller: preparation.controller,
    decisionSha256: h('0'),
    terminalSha256: h('1'),
    approvalSha256: h('2'),
  };
  const state = {
    approval: approval as unknown,
    complete: { ...approval, state: 'complete', continuationSha256: h('3') } as unknown,
    calls: [] as { route: string; body: unknown }[],
  };
  const server = http.createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const route = req.url ?? '';
    state.calls.push({ route, body: JSON.parse(Buffer.concat(parts).toString()) });
    const result = route.endsWith('empty-prepare') ? state.approval : state.complete;
    const bytes = Buffer.from(JSON.stringify(result));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': bytes.length });
    res.end(bytes);
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
  const client = new HostCoreCaptureEmptyAbortClient(socket);
  const prepare = () => client.prepare(preparation, h('0'), h('1'), signal());
  return { socket, client, preparation, approval, state, prepare };
}
it('issues distinct one-use version-two proofs without inventing a marker hash', async () => {
  const f = await fixture();
  const ready = await f.prepare();
  await useVerifiedCoreEmptyAbortApproval(ready.token, async (details) => expect(details.version).toBe(2));
  await expect(useVerifiedCoreEmptyAbortApproval(ready.token, async () => {})).rejects.toThrow();
  const done = await f.client.finish(ready.details, h('3'), signal());
  await useVerifiedCoreEmptyAbortComplete(done.token, async (details) => expect(details.sourceMarker).toBe('absent'));
  await expect(useVerifiedCoreEmptyAbortComplete(done.token, async () => {})).rejects.toThrow();
  expect(f.state.calls[0]?.body).toEqual({ preparationSha256: h('a'), decisionSha256: h('0'), terminalSha256: h('1') });
  expect(ready.details).not.toHaveProperty('sourceHoldSha256');
});
it.each(['version', 'marker', 'extra'] as const)('refuses a changed %s protocol', async (mode) => {
  const f = await fixture();
  f.state.approval =
    mode === 'version'
      ? { ...f.approval, version: 1 }
      : mode === 'marker'
        ? { ...f.approval, sourceMarker: 'complete' }
        : { ...f.approval, sourceHoldSha256: h('9') };
  await expect(f.prepare()).rejects.toThrow();
});
it('rejects copied/cross-client approvals and forged completion tokens', async () => {
  const f = await fixture();
  const ready = await f.prepare();
  await expect(f.client.finish({ ...ready.details }, h('3'), signal())).rejects.toThrow();
  await expect(new HostCoreCaptureEmptyAbortClient(f.socket).finish(ready.details, h('3'), signal())).rejects.toThrow();
  await expect(useVerifiedCoreEmptyAbortComplete({} as VerifiedCoreEmptyAbortComplete, async () => {})).rejects.toThrow();
  expect(f.state.calls).toHaveLength(1);
});
it('refuses a changed completed binding and a socket change after callback work', async () => {
  const f = await fixture();
  const ready = await f.prepare();
  f.state.complete = { ...f.approval, state: 'complete', continuationSha256: h('9') };
  await expect(f.client.finish(ready.details, h('3'), signal())).rejects.toThrow();
  await expect(
    useVerifiedCoreEmptyAbortApproval(ready.token, async () => {
      await fs.chmod(f.socket, 0o666);
    }),
  ).rejects.toThrow();
  await fs.chmod(f.socket, 0o600);
});
