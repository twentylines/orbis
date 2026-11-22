import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HostCredentialRecoveryBroker, type OwnershipGrant } from './host-broker';
import { RecoveryChangeCoordinator } from './change-coordinator';

vi.unmock('fs');
vi.unmock('node:fs');
vi.unmock('fs/promises');
vi.unmock('node:fs/promises');
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const h = (char: string) => char.repeat(64);
const binding = h('a');
const operationId = h('b');
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const baseline = Buffer.from('synthetic baseline');
const planned = Buffer.from('synthetic planned');
const prepare = () => ({
  requestId: h('c'),
  admissionBinding: binding,
  baselineIdentity: Buffer.from(baseline),
  plannedIdentity: Buffer.from(planned),
});
const pending = () => ({
  operationId,
  state: 'pending',
  admissionBinding: binding,
  baselineSha256: digest(baseline),
  plannedSha256: digest(planned),
});
const completed = () => ({ operationId, state: 'completed', admissionBinding: binding, plannedSha256: digest(planned) });
const held = 'Credential synchronization could not be verified. Check recovery before trying again.';
const ownership = (): OwnershipGrant => ({ operationId, requestId: h('c'), purpose: 'account-removal', admissionBinding: binding, state: 'pending' });

async function directory() {
  if (!process.env.TMPDIR) throw new Error('Project-scoped TMPDIR required.');
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.TMPDIR, 'hb-')));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  return { root, socket: path.join(root, 's') };
}

async function fixture() {
  const paths = await directory();
  const state = {
    requests: [] as { url: string; method: string; headers: http.IncomingHttpHeaders; body: Record<string, string> | undefined }[],
    reply: { mode: 'managed', binding } as unknown,
    status: 200,
    beforeReply: async (_response: http.ServerResponse) => {},
  };
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    state.requests.push({
      url: request.url ?? '',
      method: request.method ?? '',
      headers: request.headers,
      body: bytes.length ? JSON.parse(bytes.toString()) : undefined,
    });
    await state.beforeReply(response);
    if (response.destroyed || response.writableEnded || response.headersSent) return;
    const payload = Buffer.from(JSON.stringify(state.reply));
    response.writeHead(state.status, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
    response.end(payload);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, resolve);
  });
  await fs.chmod(paths.socket, 0o600);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { ...paths, state, server, client: new HostCredentialRecoveryBroker(paths.socket) };
}

it.each([
  { protocol: 'root-ownership', mode: 'unmanaged', binding },
  { protocol: 'prepared-identity', mode: 'unmanaged', binding },
  { protocol: 'prepared-identity', mode: 'managed', binding },
])('requires an exact explicit change protocol %#', async (reply) => {
  const f = await fixture();
  f.state.reply = reply;
  expect(await f.client.changeAdmission({})).toEqual(reply);
  expect(f.state.requests[0]?.method).toBe('GET');
  expect(f.state.requests[0]?.url).toBe('/v1/credentials/change-admission');
  expect(f.state.requests[0]?.body).toBeUndefined();
});

it.each([
  { mode: 'unmanaged', binding },
  { protocol: 'root-ownership', mode: 'managed', binding },
  { protocol: 'root-ownership', mode: 'unknown', binding },
  { protocol: 'prepared-identity', mode: 'unknown', binding },
  { protocol: 'local', mode: 'unmanaged', binding },
  { protocol: 'root-ownership', mode: 'unmanaged', binding: 'bad' },
  { protocol: 'root-ownership', mode: 'unmanaged', binding, extra: true },
])('never converts an invalid or older change admission into local authority %#', async (reply) => {
  const f = await fixture();
  f.state.reply = reply;
  await expect(f.client.changeAdmission({})).rejects.toThrow(held);
  expect(f.state.requests).toHaveLength(1);
});

async function raw(wire: string | Buffer, timeoutMs = 1000) {
  const paths = await directory();
  let calls = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((connection) => {
    sockets.add(connection);
    connection.on('error', () => {});
    connection.on('close', () => sockets.delete(connection));
    connection.once('data', () => {
      calls++;
      connection.end(wire);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, resolve);
  });
  await fs.chmod(paths.socket, 0o600);
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return { ...paths, client: new HostCredentialRecoveryBroker(paths.socket, { timeoutMs }), calls: () => calls };
}

it('binds ownership writes to the exact fixed Root protocol without sending caller authority claims', async () => {
  const f = await fixture();
  f.state.reply = ownership();
  const grant = await f.client.ownershipPrepare({ requestId: h('c'), purpose: 'account-removal' });
  expect(Object.isFrozen(grant)).toBe(true);
  expect(await f.client.ownershipCheck(grant)).toEqual(grant);
  f.state.reply = { ...grant, state: 'completed' };
  expect((await f.client.ownershipComplete(grant, 'committed')).state).toBe('completed');
  expect(f.state.requests.map((r) => [r.method, r.url, r.body])).toEqual([
    ['POST', '/v1/credentials/ownership-prepare', { requestId: h('c'), purpose: 'account-removal' }],
    ['POST', '/v1/credentials/ownership-check', { operationId, admissionBinding: binding, purpose: 'account-removal' }],
    ['POST', '/v1/credentials/ownership-complete', { operationId, admissionBinding: binding, purpose: 'account-removal', disposition: 'committed' }],
  ]);
});

it('retains completed preparation as a replay result, never a pending grant', async () => {
  const f = await fixture();
  f.state.reply = { ...ownership(), state: 'completed' };
  const replay = await f.client.ownershipPrepare({ requestId: h('c'), purpose: 'account-removal' });
  expect(replay.state).toBe('completed');
  await expect(f.client.ownershipCheck(replay)).rejects.toThrow(held);
  expect(f.state.requests).toHaveLength(1);
});

it.each([
  { requestId: h('d') },
  { purpose: 'first-registration' },
  { purpose: 'unknown' },
  { state: 'unknown' },
  { operationId: 'bad' },
  { admissionBinding: 'bad' },
  { extra: true },
])('rejects malformed or crossed ownership preparation %#', async (patch) => {
  const f = await fixture();
  f.state.reply = { ...ownership(), ...patch };
  await expect(f.client.ownershipPrepare({ requestId: h('c'), purpose: 'account-removal' })).rejects.toThrow(held);
  expect(f.state.requests).toHaveLength(1);
});

it.each([{ operationId: h('d') }, { requestId: h('e') }, { admissionBinding: h('f') }, { purpose: 'first-registration' }, { extra: true }])(
  'rejects crossed ownership check and completion tuples %#',
  async (patch) => {
    const f = await fixture();
    f.state.reply = { ...ownership(), ...patch };
    await expect(f.client.ownershipCheck(ownership())).rejects.toThrow(held);
    f.state.reply = { ...ownership(), state: 'completed', ...patch };
    await expect(f.client.ownershipComplete(ownership(), 'not-written')).rejects.toThrow(held);
    expect(f.state.requests).toHaveLength(2);
  },
);

it('does not release from pending completion, accept completed recheck, or send invalid input', async () => {
  const f = await fixture();
  f.state.reply = ownership();
  await expect(f.client.ownershipComplete(ownership(), 'not-written')).rejects.toThrow(held);
  f.state.reply = { ...ownership(), state: 'completed' };
  await expect(f.client.ownershipCheck(ownership())).rejects.toThrow(held);
  await expect(f.client.ownershipPrepare({ requestId: 'bad', purpose: 'account-removal' })).rejects.toThrow(held);
  await expect(f.client.ownershipComplete(ownership(), 'rollback' as never)).rejects.toThrow(held);
  expect(f.state.requests).toHaveLength(2);
});

it('keeps a failed or lost ownership reply held with no automatic retry', async () => {
  const f = await fixture();
  f.state.status = 503;
  await expect(f.client.ownershipPrepare({ requestId: h('c'), purpose: 'account-removal' })).rejects.toThrow(held);
  f.state.beforeReply = async (response) => {
    response.destroy();
  };
  await expect(f.client.ownershipComplete(ownership(), 'committed')).rejects.toThrow(held);
  expect(f.state.requests).toHaveLength(2);
});

it('applies bounded exact framing and cancellation to ownership grants', async () => {
  const f = await raw(wire(JSON.stringify(ownership()), 'Content-Encoding: identity\r\n'));
  await expect(f.client.ownershipPrepare({ requestId: h('c'), purpose: 'account-removal' })).rejects.toThrow(held);
  expect(f.calls()).toBe(1);
  const g = await fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(g.client.ownershipCheck(ownership(), abort.signal)).rejects.toThrow(held);
  expect(g.state.requests).toHaveLength(0);
});

function wire(body: string | Buffer, headers = '', status = '200 OK') {
  const bytes = Buffer.from(body);
  return Buffer.concat([
    Buffer.from(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${bytes.length}\r\n${headers}\r\n`),
    bytes,
  ]);
}

it('uses only exact host routes, headers and detached base64 source bodies', async () => {
  const f = await fixture();
  expect(await f.client.admission({})).toEqual({ mode: 'managed', binding });
  f.state.reply = pending();
  const first = prepare();
  const before = Buffer.from(first.baselineIdentity);
  expect(await f.client.prepare(first)).toEqual(pending());
  expect(first.baselineIdentity).toEqual(before);
  f.state.reply = completed();
  expect(await f.client.complete({ operationId, admissionBinding: binding, currentIdentity: planned })).toEqual(completed());
  expect(f.state.requests.map((request) => [request.method, request.url, request.headers.host, request.headers.connection])).toEqual([
    ['GET', '/v1/credentials/admission', 'orbis', 'close'],
    ['POST', '/v1/credentials/prepare', 'orbis', 'close'],
    ['POST', '/v1/credentials/complete', 'orbis', 'close'],
  ]);
  expect(f.state.requests[0]?.body).toBeUndefined();
  expect(f.state.requests[1]?.body).toEqual({
    requestId: h('c'),
    admissionBinding: binding,
    baselineIdentityBase64: baseline.toString('base64'),
    plannedIdentityBase64: planned.toString('base64'),
  });
  expect(f.state.requests[2]?.body).toEqual({ operationId, admissionBinding: binding, currentIdentityBase64: planned.toString('base64') });
});

it('accepts explicit unmanaged admission without bypassing its prepare and complete requests', async () => {
  const f = await fixture();
  f.state.reply = { mode: 'unmanaged', binding };
  expect(await f.client.admission({})).toEqual({ mode: 'unmanaged', binding });
  f.state.reply = pending();
  await f.client.prepare(prepare());
  f.state.reply = completed();
  await f.client.complete({ operationId, admissionBinding: binding, currentIdentity: planned });
  expect(f.state.requests).toHaveLength(3);
});

it.each([undefined, '', 'relative', '/a/../b', '/bad\0socket', `/${'a'.repeat(107)}`])('refuses invalid socket configuration %s', (socket) => {
  expect(() => new HostCredentialRecoveryBroker(socket)).toThrow(held);
});

it.each([0, -1, 180001, Number.NaN, 1.5])('refuses invalid trusted timeout %s', (timeoutMs) => {
  expect(() => new HostCredentialRecoveryBroker('/run/orbis/host.sock', { timeoutMs })).toThrow(held);
});

it('missing and replaced or permissive endpoints remain held', async () => {
  const f = await fixture();
  await fs.chmod(f.socket, 0o666);
  await expect(f.client.admission({})).rejects.toThrow(held);
  expect(f.state.requests).toHaveLength(0);
  await fs.chmod(f.socket, 0o600);
  f.state.beforeReply = async () => {
    await fs.rename(f.socket, `${f.socket}-old`);
  };
  await expect(f.client.admission({})).rejects.toThrow(held);
  expect(f.state.requests).toHaveLength(1);
});

it.each([404, 409, 500, 503, 302])('does not retry or downgrade HTTP %s to unmanaged', async (status) => {
  const f = await fixture();
  f.state.status = status;
  f.state.reply = { mode: 'unmanaged', binding, private: 'must never escape' };
  await expect(f.client.admission({})).rejects.toThrow(held);
  expect(f.state.requests).toHaveLength(1);
});

it.each([
  `{"mode":"managed","binding":"${binding}","binding":"${binding}"}`,
  `{"mode":"managed","binding":"${binding}","\\u0062inding":"${binding}"}`,
  `{"mode":"managed","binding":"${binding}","extra":"private"}`,
  `{"mode":"unknown","binding":"${binding}"}`,
  '{"mode":"managed","binding":{}}',
  `{"mode":"managed","binding":"${binding}",}`,
  '[]',
  'null',
  '{}',
  `\ufeff{"mode":"managed","binding":"${binding}"}`,
])('rejects nonexact, duplicate or malformed receipt %#', async (body) => {
  const f = await raw(wire(body));
  await expect(f.client.admission({})).rejects.toThrow(held);
  expect(f.calls()).toBe(1);
});

it.each([
  'Content-Type: application/json\r\n',
  'Content-Encoding: identity\r\n',
  'Trailer: x-status\r\n',
  'X-Test: one\r\nx-test: two\r\n',
  'Content-Length: 1\r\n',
  'Transfer-Encoding: chunked\r\n',
])('rejects duplicate or encoded/framing headers %#', async (headers) => {
  const f = await raw(wire(JSON.stringify({ mode: 'managed', binding }), headers));
  await expect(f.client.admission({})).rejects.toThrow(held);
});

it('rejects invalid UTF8, oversize, truncated and missing-length responses', async () => {
  for (const response of [
    wire(Buffer.from([0xff])),
    wire('x'.repeat(4097)),
    Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{}'),
    Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{}'),
  ]) {
    const f = await raw(response);
    await expect(f.client.admission({})).rejects.toThrow(held);
  }
});

it('rejects trailing unsolicited bytes after the declared response body', async () => {
  const f = await raw(Buffer.concat([wire(JSON.stringify({ mode: 'managed', binding })), Buffer.from('private trailing bytes')]));
  await expect(f.client.admission({})).rejects.toThrow(held);
});

it('rejects crossed pending and completed receipts and never returns their private extras', async () => {
  const f = await fixture();
  for (const patch of [
    { admissionBinding: h('d') },
    { baselineSha256: h('e') },
    { plannedSha256: h('f') },
    { operationId: 'bad' },
    { state: 'completed' },
    { changeToken: 'private-root-token' },
  ]) {
    f.state.reply = { ...pending(), ...patch };
    await expect(f.client.prepare(prepare())).rejects.toThrow(held);
  }
  for (const patch of [
    { operationId: h('c') },
    { admissionBinding: h('d') },
    { plannedSha256: h('e') },
    { state: 'pending' },
    { identity: 'private-root-source' },
  ]) {
    f.state.reply = { ...completed(), ...patch };
    await expect(f.client.complete({ operationId, admissionBinding: binding, currentIdentity: planned })).rejects.toThrow(held);
  }
});

it('rejects source and identifier bounds before any request and accepts both maximum source sizes', async () => {
  const f = await fixture();
  for (const value of [Buffer.alloc(0), Buffer.alloc(65537), new Uint8Array(2) as Buffer]) {
    await expect(f.client.prepare({ ...prepare(), baselineIdentity: value })).rejects.toThrow(held);
    await expect(f.client.complete({ operationId, admissionBinding: binding, currentIdentity: value })).rejects.toThrow(held);
  }
  await expect(f.client.prepare({ ...prepare(), requestId: 'bad' })).rejects.toThrow(held);
  expect(f.state.requests).toHaveLength(0);
  const large = Buffer.alloc(65536, 42);
  f.state.reply = { ...pending(), baselineSha256: digest(large), plannedSha256: digest(large) };
  await f.client.prepare({ ...prepare(), baselineIdentity: large, plannedIdentity: large });
  expect(Number(f.state.requests[0]?.headers['content-length'])).toBeLessThanOrEqual(196608);
});

it('cancelled and lost responses are held once without retrying', async () => {
  const f = await fixture();
  const abort = new AbortController();
  abort.abort();
  await expect(f.client.admission({ signal: abort.signal })).rejects.toThrow(held);
  expect(f.state.requests).toHaveLength(0);
  f.state.beforeReply = async (response) => {
    response.destroy();
  };
  await expect(f.client.prepare(prepare())).rejects.toThrow(held);
  expect(f.state.requests).toHaveLength(1);
});

it('uses an absolute deadline across a trickling response and supports abort after headers', async () => {
  const f = await fixture();
  let interval: ReturnType<typeof setInterval> | undefined;
  f.state.beforeReply = async (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 1000 });
    response.write('{');
    interval = setInterval(() => response.write(' '), 5);
    response.once('close', () => {
      if (interval) clearInterval(interval);
    });
  };
  const client = new HostCredentialRecoveryBroker(f.socket, { timeoutMs: 70 });
  await expect(client.admission({})).rejects.toThrow(held);
  const abort = new AbortController();
  const promise = f.client.admission({ signal: abort.signal });
  setTimeout(() => abort.abort(), 30);
  await expect(promise).rejects.toThrow(held);
  expect(f.state.requests).toHaveLength(2);
});

it('the actual coordinator refuses unavailable admission before authorization or any writer', async () => {
  const f = await fixture();
  f.state.status = 503;
  const authorize = vi.fn();
  const transaction = vi.fn();
  const coordinator = new RecoveryChangeCoordinator({
    broker: f.client,
    origin: 'https://orbis.example',
    config: { get: (key: string) => (key === 'directories' ? { dataDir: f.root } : 'synthetic-context') },
    users: { withCredentialTransaction: transaction },
    database: { transaction },
    passkeys: {} as never,
    encryption: {} as never,
  } as never);
  await expect(coordinator.change({ accountId: 1, authorize, plan: () => ({ patch: {}, value: 'never' }) })).rejects.toThrow();
  expect(authorize).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();
  expect(f.state.requests).toHaveLength(1);
});

const counterOptions = () => ({ admissionBinding: binding, purpose: 'login' as const, ceremonyBinding: h('c') });
const counterChallenge = () => ({
  schema: 'orbis.sentinel-main-passkey-challenge.v1',
  mode: 'managed',
  admissionBinding: binding,
  challenge: Buffer.alloc(32, 7).toString('base64url'),
  expiresAtMs: Date.now() + 110000,
  generation: 2,
  revision: h('e'),
  accountId: 1,
  rpID: 'recovery.example',
  credentialIds: ['a2V5'],
});

it('uses fixed counter routes and correlates Root nonce, authority, key, source and expiry', async () => {
  const f = await fixture();
  const challenge = counterChallenge();
  f.state.reply = challenge;
  const ceremony = await f.client.counterChallenge(counterOptions());
  expect(Object.isFrozen(ceremony)).toBe(true);
  expect(Object.isFrozen(ceremony.credentialIds)).toBe(true);
  const assertion = { id: 'a2V5', response: { signature: 'synthetic-fixture' } };
  f.state.reply = {
    schema: 'orbis.sentinel-main-passkey-counter.v1',
    admissionBinding: binding,
    challenge: challenge.challenge,
    generation: 2,
    revision: h('e'),
    accountId: 1,
    credentialId: 'a2V5',
    previousCounter: 4,
    newCounter: 5,
    expiresAtMs: challenge.expiresAtMs,
  };
  expect(await f.client.counterComplete({ ceremony, response: assertion })).toEqual({
    accountId: 1,
    credentialId: 'a2V5',
    previousCounter: 4,
    newCounter: 5,
  });
  const identity = Buffer.from('private synthetic identity');
  f.state.reply = {
    schema: 'orbis.sentinel-main-counter-floors.v1',
    admissionBinding: binding,
    sourceSha256: digest(identity),
    generation: 2,
    revision: h('e'),
    counters: { a2V5: 5 },
  };
  const floors = await f.client.counterFloors({ admissionBinding: binding, identity });
  expect(floors.counters).toEqual({ a2V5: 5 });
  expect(Object.isFrozen(floors.counters)).toBe(true);
  expect(identity.toString()).toBe('private synthetic identity');
  expect(f.state.requests.map((r) => [r.method, r.url, r.headers.host])).toEqual([
    ['POST', '/v1/credentials/counter-challenge', 'orbis'],
    ['POST', '/v1/credentials/counter-complete', 'orbis'],
    ['POST', '/v1/credentials/counter-floors', 'orbis'],
  ]);
  expect(f.state.requests[0]?.body).toEqual(counterOptions());
  expect(f.state.requests[1]?.body).toEqual({ ...counterOptions(), challenge: challenge.challenge, response: assertion });
  expect(f.state.requests[2]?.body).toEqual({ admissionBinding: binding, identityBase64: identity.toString('base64') });
});

it('explicit unmanaged counter admission retains no Root nonce or caller AbortSignal', async () => {
  const f = await fixture();
  f.state.reply = { mode: 'unmanaged', admissionBinding: binding };
  const ceremony = await f.client.counterChallenge({ ...counterOptions(), signal: new AbortController().signal });
  expect(ceremony).toEqual({ mode: 'unmanaged', ...counterOptions() });
  await expect(f.client.counterComplete({ ceremony, response: {} })).rejects.toThrow(held);
  expect(f.state.requests).toHaveLength(1);
});

it.each([
  { admissionBinding: h('d') },
  { schema: 'old' },
  { mode: 'unknown' },
  { challenge: 'invalid' },
  { expiresAtMs: 0 },
  { expiresAtMs: Date.now() + 86400000 },
  { generation: -1 },
  { accountId: 0 },
  { revision: 'old' },
  { credentialIds: [] },
  { credentialIds: ['a2V5', 'a2V5'] },
  { credentialIds: ['a2V5='] },
  { extra: 'private' },
])('refuses malformed or crossed Root counter ceremony %#', async (patch) => {
  const f = await fixture();
  f.state.reply = { ...counterChallenge(), ...patch };
  await expect(f.client.counterChallenge(counterOptions())).rejects.toThrow(held);
  expect(f.state.requests).toHaveLength(1);
});

it.each([
  { admissionBinding: h('d') },
  { challenge: Buffer.alloc(32, 8).toString('base64url') },
  { generation: 3 },
  { revision: h('f') },
  { accountId: 2 },
  { credentialId: 'b3RoZXI' },
  { previousCounter: 5, newCounter: 5 },
  { previousCounter: 5, newCounter: 4 },
  { previousCounter: -1 },
  { newCounter: 0x100000000 },
  { expiresAtMs: 0 },
  { extra: 'private' },
])('refuses crossed, rollback or nonexact counter receipt %#', async (patch) => {
  const f = await fixture();
  const challenge = counterChallenge();
  f.state.reply = challenge;
  const ceremony = await f.client.counterChallenge(counterOptions());
  f.state.reply = {
    schema: 'orbis.sentinel-main-passkey-counter.v1',
    admissionBinding: binding,
    challenge: challenge.challenge,
    generation: 2,
    revision: h('e'),
    accountId: 1,
    credentialId: 'a2V5',
    previousCounter: 4,
    newCounter: 5,
    expiresAtMs: challenge.expiresAtMs,
    ...patch,
  };
  await expect(f.client.counterComplete({ ceremony, response: {} })).rejects.toThrow(held);
  expect(f.state.requests).toHaveLength(2);
});

it('accepts fresh zero-counter proof metadata but refuses duplicate nested floor keys', async () => {
  const f = await fixture();
  const challenge = counterChallenge();
  f.state.reply = challenge;
  const ceremony = await f.client.counterChallenge(counterOptions());
  f.state.reply = {
    schema: 'orbis.sentinel-main-passkey-counter.v1',
    admissionBinding: binding,
    challenge: challenge.challenge,
    generation: 2,
    revision: h('e'),
    accountId: 1,
    credentialId: 'a2V5',
    previousCounter: 0,
    newCounter: 0,
    expiresAtMs: challenge.expiresAtMs,
  };
  expect((await f.client.counterComplete({ ceremony, response: {} })).newCounter).toBe(0);
  const identity = Buffer.from('synthetic');
  const g = await raw(
    wire(
      `{"schema":"orbis.sentinel-main-counter-floors.v1","admissionBinding":"${binding}","sourceSha256":"${digest(identity)}","generation":2,"revision":"${h('e')}","counters":{"a2V5":1,"\\u00612V5":2}}`,
    ),
  );
  await expect(g.client.counterFloors({ admissionBinding: binding, identity })).rejects.toThrow(held);
});

it.each([
  { sourceSha256: h('f') },
  { counters: { a2V5: -1 } },
  { counters: { a2V5: 1.5 } },
  { counters: { a2V5: 0x100000000 } },
  { counters: { 'a2V5=': 1 } },
  { counters: [] },
  { extra: 1 },
])('rejects invalid or uncorrelated floor receipt %#', async (patch) => {
  const f = await fixture();
  const identity = Buffer.from('synthetic');
  f.state.reply = {
    schema: 'orbis.sentinel-main-counter-floors.v1',
    admissionBinding: binding,
    sourceSha256: digest(identity),
    generation: 2,
    revision: h('e'),
    counters: { a2V5: 2 },
    ...patch,
  };
  await expect(f.client.counterFloors({ admissionBinding: binding, identity })).rejects.toThrow(held);
});

it('accepts ten legitimate large credential IDs without relaxing the ordinary 4096-byte receipt bound', async () => {
  const f = await fixture();
  const credentialIds = Array.from({ length: 10 }, (_, index) => Buffer.alloc(1536, index).toString('base64url'));
  const reply = { ...counterChallenge(), credentialIds };
  expect(Buffer.byteLength(JSON.stringify(reply))).toBeGreaterThan(4096);
  f.state.reply = reply;
  const ceremony = await f.client.counterChallenge(counterOptions());
  expect(ceremony.credentialIds).toEqual(credentialIds);
  const identity = Buffer.from('large synthetic vector');
  f.state.reply = {
    schema: 'orbis.sentinel-main-counter-floors.v1',
    admissionBinding: binding,
    sourceSha256: digest(identity),
    generation: 2,
    revision: h('e'),
    counters: Object.fromEntries(credentialIds.map((id) => [id, 3])),
  };
  expect(Object.keys((await f.client.counterFloors({ admissionBinding: binding, identity })).counters)).toEqual(credentialIds);
});
