import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  HostCoreCaptureAbortClient,
  useVerifiedCoreAbortIntent,
  useVerifiedCoreAbortApproval,
  useVerifiedCoreAbortComplete,
  type CoreCaptureAbortPreparation,
  type VerifiedCoreAbortComplete,
  type VerifiedCoreAbortIntent,
} from './host-core-capture-abort-client';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const hash = (value: string) => value.repeat(64);
const signal = () => new AbortController().signal;
async function fixture() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'ac-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const socket = path.join(root, 's');
  const preparation: CoreCaptureAbortPreparation = {
    version: 3,
    id: '11111111-1111-4111-8111-111111111111',
    preparationSha256: hash('a'),
    sourceSha256: hash('b'),
    pointReservationSha256: hash('c'),
    controller: { id: hash('d'), imageId: `sha256:${hash('e')}`, startedAt: '2026-11-06T00:00:00Z', definitionSha256: hash('f') },
  };
  const intent = { version: 1, id: preparation.id, state: 'abort-intent', preparationSha256: hash('a'), decisionSha256: hash('0') };
  const approval = {
    version: 1,
    id: preparation.id,
    state: 'verified-abort-awaiting-continuation',
    preparationSha256: hash('a'),
    decisionSha256: hash('0'),
    terminalSha256: hash('1'),
    approvalSha256: hash('2'),
    sourceSha256: hash('b'),
    sourceHoldSha256: hash('3'),
    pointReservationSha256: hash('c'),
    controller: preparation.controller,
  };
  const complete = { ...approval, state: 'complete', continuationSha256: hash('4') };
  const state = {
    intent: intent as unknown,
    approval: approval as unknown,
    complete: complete as unknown,
    drop: '',
    status: 200,
    afterReply: async () => {},
    calls: [] as { route: string; body: unknown }[],
  };
  const server = http.createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const raw of request) parts.push(Buffer.from(raw));
    const route = request.url ?? '';
    state.calls.push({ route, body: JSON.parse(Buffer.concat(parts).toString()) });
    if (state.drop && route.endsWith(state.drop)) {
      state.drop = '';
      request.socket.destroy();
      return;
    }
    const value = route.includes('/abort-intent') ? state.intent : route.endsWith('/abort-prepare') ? state.approval : state.complete;
    const bytes = Buffer.from(JSON.stringify(value));
    response.writeHead(state.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': bytes.length });
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
  const client = new HostCoreCaptureAbortClient(socket);
  const prepare = () => client.prepare(preparation, hash('0'), hash('1'), hash('3'), signal());
  return { root, socket, state, client, preparation, intent, approval, complete, prepare };
}

it('binds distinct single-use intent, continuation and complete tokens to exact root replies', async () => {
  const f = await fixture();
  const intent = await f.client.intent(f.preparation, signal());
  expect(Object.isFrozen(intent.details.controller)).toBe(true);
  await useVerifiedCoreAbortIntent(intent.token, async (details) => expect(details.decisionSha256).toBe(hash('0')));
  await expect(useVerifiedCoreAbortIntent(intent.token, async () => undefined)).rejects.toThrow();
  const approval = await f.prepare();
  await useVerifiedCoreAbortApproval(approval.token, async (details) => expect(details).toEqual(f.approval));
  await expect(useVerifiedCoreAbortApproval(approval.token, async () => undefined)).rejects.toThrow();
  const done = await f.client.finish(approval.details, hash('4'), signal());
  await useVerifiedCoreAbortComplete(done.token, async (details) => expect(details).toEqual(f.complete));
  await expect(useVerifiedCoreAbortComplete(done.token, async () => undefined)).rejects.toThrow();
  expect(f.state.calls.map((call) => call.body)).toEqual([
    { preparationSha256: hash('a') },
    { preparationSha256: hash('a'), decisionSha256: hash('0'), terminalSha256: hash('1') },
    { preparationSha256: hash('a'), decisionSha256: hash('0'), terminalSha256: hash('1'), approvalSha256: hash('2'), continuationSha256: hash('4') },
  ]);
});

it('observes a lost intent response without replaying the decision write', async () => {
  const f = await fixture();
  f.state.drop = '/abort-intent';
  await expect(f.client.intent(f.preparation, signal())).rejects.toThrow();
  await expect(f.client.intent(f.preparation, signal())).rejects.toThrow();
  const observed = await f.client.observeIntent(f.preparation, signal());
  await useVerifiedCoreAbortIntent(observed.token, async () => undefined);
  expect(f.state.calls.map((call) => call.route.split('/').slice(-2).join('/'))).toEqual([`${f.preparation.id}/abort-intent`, 'abort-intent/status']);
});

it('reconciles a lost finish reply through positive status without starting another cleanup', async () => {
  const f = await fixture();
  const approved = await f.prepare();
  f.state.drop = '/abort-finish';
  await expect(f.client.finish(approved.details, hash('4'), signal())).rejects.toThrow();
  const done = await f.client.observeComplete(approved.details, hash('4'), signal());
  await useVerifiedCoreAbortComplete(done.token, async () => undefined);
  expect(f.state.calls.filter((call) => call.route.endsWith('/abort-finish'))).toHaveLength(1);
  expect(f.state.calls.at(-1)?.body).toEqual({ preparationSha256: hash('a'), decisionSha256: hash('0'), terminalSha256: hash('1') });
});

it.each(['intent', 'approval', 'complete'] as const)('rejects unknown or changed %s contract fields', async (kind) => {
  const f = await fixture();
  if (kind === 'intent') {
    f.state.intent = { ...f.intent, released: true };
    await expect(f.client.intent(f.preparation, signal())).rejects.toThrow();
  } else if (kind === 'approval') {
    f.state.approval = { ...f.approval, decisionSha256: hash('9') };
    await expect(f.prepare()).rejects.toThrow();
  } else {
    const ready = await f.prepare();
    f.state.complete = { ...f.complete, continuationSha256: hash('9') };
    await expect(f.client.finish(ready.details, hash('4'), signal())).rejects.toThrow();
  }
});

it('rejects preparation-v2 and invalid identifiers before contacting the helper', async () => {
  const f = await fixture();
  await expect(f.client.intent({ ...f.preparation, version: 2 } as unknown as CoreCaptureAbortPreparation, signal())).rejects.toThrow();
  await expect(f.client.intent({ ...f.preparation, id: '../point' }, signal())).rejects.toThrow();
  expect(f.state.calls).toEqual([]);
});

it('refuses forged grants and approval objects issued to another client', async () => {
  const f = await fixture();
  await expect(useVerifiedCoreAbortIntent({} as VerifiedCoreAbortIntent, async () => undefined)).rejects.toThrow();
  await expect(useVerifiedCoreAbortComplete({} as VerifiedCoreAbortComplete, async () => undefined)).rejects.toThrow();
  const ready = await f.prepare();
  await expect(f.client.finish({ ...ready.details }, hash('4'), signal())).rejects.toThrow();
  await expect(new HostCoreCaptureAbortClient(f.socket).finish(ready.details, hash('4'), signal())).rejects.toThrow();
  expect(f.state.calls).toHaveLength(1);
});

it('keeps callback failure and a socket change consumed without issuing another token', async () => {
  const f = await fixture();
  const failed = await f.client.intent(f.preparation, signal());
  await expect(
    useVerifiedCoreAbortIntent(failed.token, async () => {
      throw new Error('fixture callback failed');
    }),
  ).rejects.toThrow('fixture callback');
  await expect(useVerifiedCoreAbortIntent(failed.token, async () => undefined)).rejects.toThrow();
  const observed = await f.client.observeIntent(f.preparation, signal());
  await expect(
    useVerifiedCoreAbortIntent(observed.token, async () => {
      await fs.chmod(f.socket, 0o666);
    }),
  ).rejects.toThrow();
  await fs.chmod(f.socket, 0o600);
  await expect(useVerifiedCoreAbortIntent(observed.token, async () => undefined)).rejects.toThrow();
});

it('refuses missing socket after a response and does not classify it as retryable transport failure', async () => {
  const f = await fixture();
  f.state.afterReply = async () => fs.rename(f.socket, `${f.socket}.retained`);
  const error = await f.client.intent(f.preparation, signal()).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toHaveProperty('code');
});
