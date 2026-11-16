import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  coreCaptureRestartRetirementReaderCapability,
  HostCoreCaptureRestartRetirementClient,
  type VerifiedCoreCaptureRetirement,
} from '../host-updates/host-core-capture-restart-retirement-client';
import { coreCapturePointReservationSha256 } from './time-machine-core-reservation';
import { TimeMachineStore } from './time-machine-store';
import { TimeMachineService } from './time-machine.service';
import { coreCapsuleFixture } from '../time-machine-capsules/core-capsule.fixture';

const cleanup: (() => Promise<unknown>)[] = [];
const signal = () => new AbortController().signal;
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture(sealed = false) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rr-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const captured = sealed ? await coreCapsuleFixture() : null;
  if (captured) cleanup.push(() => captured.dispose());
  const data = captured?.root ?? path.join(root, 'data');
  await fs.mkdir(data, { recursive: true, mode: 0o700 });
  const store = captured?.store ?? new TimeMachineStore(data);
  const created = captured?.point ?? (await store.create(1, 3)).point;
  if (created.version !== 3) throw new Error('Core fixture required');
  if (!sealed) await store.update({ ...created, status: 'interrupted', issue: 'capture-interrupted' });
  const point = await store.load(created.id);
  if (point.version !== 3) throw new Error('Core fixture required');
  const file = path.join(data, 'backups/time-machine/points', point.id, 'point.json');
  const before = await fs.readFile(file);
  const reservation = coreCapturePointReservationSha256(point);
  const expected = {
    version: 1,
    id: point.id,
    state: 'preparation-retired',
    pointReservationSha256: reservation,
    pointRecordSha256: sha(before),
    sourceSha256: 'a'.repeat(64),
    intentSha256: 'b'.repeat(64),
    receiptSha256: 'c'.repeat(64),
    scope: 'retire-unadmitted-preparation-after-controller-restart-only',
    captureCompleted: false,
    sourceAttempt: 'unknown-before-controller-restart',
    queueStateProved: false,
    hostRebootProved: false,
    activation: false,
    restoreAuthority: false,
  };
  const state = { value: expected as unknown, capability: coreCaptureRestartRetirementReaderCapability as unknown, capStatus: 200 };
  const requests: { method: string | undefined; route: string | undefined; body: unknown }[] = [];
  const socket = path.join(root, 's');
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    requests.push({ method: request.method, route: request.url, body: bytes.length ? JSON.parse(bytes.toString()) : null });
    const capability = request.url?.endsWith('/restart-retirement-capability');
    const body = Buffer.from(JSON.stringify(capability ? state.capability : state.value));
    response.writeHead(capability ? state.capStatus : 200, {
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
  const reader = new HostCoreCaptureRestartRetirementClient(socket);
  const token = async () => {
    const value = await reader.observe(point.id, reservation, signal());
    if (!value) throw new Error('Missing verified fixture receipt');
    return value;
  };
  return { root, data, store, point, file, before, reservation, expected, state, requests, socket, reader, token };
}

it('recovers only the empty interrupted point using the exact committed receipt and preserves its encryption ownership', async () => {
  const f = await fixture();
  const result = await f.store.retireUnadmittedCorePoint(f.point.id, await f.token());
  expect(result).toEqual({ id: f.point.id, changed: true, persisted: true });
  const current = await f.store.load(f.point.id);
  expect(current).toEqual({ ...f.point, status: 'failed', issue: 'capture-failed' });
  expect(current.envelope).toEqual(f.point.envelope);
  expect(current.ownerId).toBe(f.point.ownerId);
  expect(await fs.readdir(path.dirname(f.file))).toEqual(['point.json']);
  expect(f.requests.map((request) => [request.method, request.route])).toEqual([
    ['GET', '/v1/core-captures/restart-retirement-capability'],
    ['POST', `/v1/core-captures/${f.point.id}/restart-retirement`],
  ]);
  expect(f.requests[1]?.body).toEqual({ pointReservationSha256: f.reservation });
  expect(await f.store.retireUnadmittedCorePoint(f.point.id, await f.token())).toEqual({ id: f.point.id, changed: false, persisted: true });
});

it('supports a read-only eligibility check and consumes each verified receipt once', async () => {
  const f = await fixture();
  const token = await f.token();
  expect(await f.store.retireUnadmittedCorePoint(f.point.id, token, true)).toEqual({ id: f.point.id, changed: true, persisted: false });
  expect(await fs.readFile(f.file)).toEqual(f.before);
  await expect(fs.stat(path.join(f.data, 'backups/time-machine/preparation-retirements'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(f.store.retireUnadmittedCorePoint(f.point.id, token)).rejects.toThrow();
});

it('keeps a point held when an older helper lacks the reader or Root has not committed retirement', async () => {
  const f = await fixture();
  f.state.capStatus = 404;
  f.state.capability = { error: 'Unsupported fixed route' };
  expect(await f.reader.observe(f.point.id, f.reservation, signal())).toBeNull();
  expect(f.requests).toHaveLength(1);
  f.state.capStatus = 200;
  f.state.capability = coreCaptureRestartRetirementReaderCapability;
  const { pointRecordSha256: _record, sourceSha256: _source, intentSha256: _intent, receiptSha256: _receipt, ...pending } = f.expected;
  f.state.value = { ...pending, state: 'not-retired' };
  expect(await f.reader.observe(f.point.id, f.reservation, signal())).toBeNull();
  expect(await fs.readFile(f.file)).toEqual(f.before);
});

it.each(['id', 'reservation', 'scope', 'capture', 'queue', 'activation', 'extra', 'receipt'])(
  'rejects a substituted or overclaimed %s receipt before issuing authority',
  async (fault) => {
    const f = await fixture();
    f.state.value = {
      ...f.expected,
      ...(fault === 'id' ? { id: '11111111-1111-4111-8111-111111111111' } : {}),
      ...(fault === 'reservation' ? { pointReservationSha256: 'f'.repeat(64) } : {}),
      ...(fault === 'scope' ? { scope: 'general-recovery' } : {}),
      ...(fault === 'capture' ? { captureCompleted: true } : {}),
      ...(fault === 'queue' ? { queueStateProved: true } : {}),
      ...(fault === 'activation' ? { activation: true } : {}),
      ...(fault === 'extra' ? { sourceWrites: true } : {}),
      ...(fault === 'receipt' ? { receiptSha256: 'bad' } : {}),
    };
    await expect(f.token()).rejects.toThrow();
    expect(await fs.readFile(f.file)).toEqual(f.before);
  },
);

it('rejects forged authority and a socket replacement before touching point storage', async () => {
  const f = await fixture();
  await expect(f.store.retireUnadmittedCorePoint(f.point.id, {} as VerifiedCoreCaptureRetirement)).rejects.toThrow();
  const token = await f.token();
  await fs.chmod(f.socket, 0o660);
  await expect(f.store.retireUnadmittedCorePoint(f.point.id, token)).rejects.toThrow();
  await fs.chmod(f.socket, 0o600);
  expect(await fs.readFile(f.file)).toEqual(f.before);
});

it('preserves a sealed real encrypted capture even if a reader incorrectly claims it is retired', async () => {
  const f = await fixture(true);
  await expect(f.store.retireUnadmittedCorePoint(f.point.id, await f.token())).rejects.toThrow();
  expect(await fs.readFile(f.file)).toEqual(f.before);
  expect((await f.store.load(f.point.id)).status).toBe('sealed');
});

it.each(['point', 'artifact', 'audit'])('does not overwrite changed %s evidence', async (fault) => {
  const f = await fixture();
  const token = await f.token();
  if (fault === 'point') await f.store.update({ ...f.point, issue: 'capture-failed' });
  if (fault === 'artifact') await fs.writeFile(path.join(path.dirname(f.file), 'core.partial'), 'retained partial data', { mode: 0o600 });
  if (fault === 'audit') {
    const directory = path.join(f.data, 'backups/time-machine/preparation-retirements');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(path.join(directory, `${f.point.id}.json`), '{"unrelated":true}', { mode: 0o600 });
  }
  const current = await fs.readFile(f.file);
  await expect(f.store.retireUnadmittedCorePoint(f.point.id, token)).rejects.toThrow();
  expect(await fs.readFile(f.file)).toEqual(current);
  if (fault === 'artifact') expect(await fs.readFile(path.join(path.dirname(f.file), 'core.partial'), 'utf8')).toBe('retained partial data');
});

it('resumes after the durable audit is saved but the point update fails', async () => {
  const f = await fixture();
  const update = vi.spyOn(f.store, 'update').mockRejectedValueOnce(new Error('synthetic write interruption'));
  await expect(f.store.retireUnadmittedCorePoint(f.point.id, await f.token())).rejects.toThrow('synthetic write interruption');
  expect(await fs.readFile(f.file)).toEqual(f.before);
  update.mockRestore();
  expect((await f.store.retireUnadmittedCorePoint(f.point.id, await f.token())).persisted).toBe(true);
  expect((await f.store.load(f.point.id)).status).toBe('failed');
});

async function withLinuxService(f: Awaited<ReturnType<typeof fixture>>, work: (service: TimeMachineService) => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) throw new Error('Missing platform descriptor');
  const config = { get: (name: string) => (name === 'directories' ? { dataDir: f.data } : false) };
  const service = new TimeMachineService(
    config as never,
    {} as never,
    {} as never,
    { warn: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { recoverCaptureFences: vi.fn(async () => {}) } as never,
  );
  vi.stubEnv('ORBIS_HOST_SOCKET', f.socket);
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
  try {
    await work(service);
  } finally {
    await service.onModuleDestroy();
    Object.defineProperty(process, 'platform', descriptor);
  }
}

it('reconciles a committed capture before startup can change the receipt-bound point bytes', async () => {
  const f = await fixture();
  await f.store.update({ ...f.point, status: 'capturing', issue: null });
  f.state.value = { ...f.expected, pointRecordSha256: sha(await fs.readFile(f.file)) };
  await withLinuxService(f, async (service) => {
    await service.onModuleInit();
    expect((await f.store.load(f.point.id)).status).toBe('failed');
    const listed = await service.list(1);
    expect(listed.available).toBe(true);
    expect(listed.points).toHaveLength(1);
    expect(listed.points[0]?.status).toBe('failed');
  });
});

it('picks up a newly available Root receipt on refresh without restarting Orbis', async () => {
  const f = await fixture();
  f.state.capStatus = 404;
  f.state.capability = { error: 'Older helper' };
  await withLinuxService(f, async (service) => {
    await service.onModuleInit();
    expect((await f.store.load(f.point.id)).status).toBe('interrupted');
    f.state.capStatus = 200;
    f.state.capability = coreCaptureRestartRetirementReaderCapability;
    expect((await service.list(1)).points[0]?.status).toBe('failed');
    expect(f.requests.every((entry) => entry.method === 'GET' || entry.route?.endsWith('/restart-retirement'))).toBe(true);
  });
});
