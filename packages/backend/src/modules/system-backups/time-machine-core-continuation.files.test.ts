import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
const h = (v: string) => v.repeat(64);
const signal = () => new AbortController().signal;
const cleanups: Array<() => Promise<unknown>> = [];
let maintenance: typeof import('@/common/backup-maintenance');
let subject: typeof import('./time-machine-core-source-hold');
let clientModule: typeof import('../host-updates/host-core-capture-completion-client');
beforeEach(async () => {
  vi.resetModules();
  maintenance = await import('@/common/backup-maintenance');
  subject = await import('./time-machine-core-source-hold');
  clientModule = await import('../host-updates/host-core-capture-completion-client');
  maintenance.setBackupRecoveryRequired(false);
  maintenance.setResetRecoveryRequired(false);
  maintenance.setRestoreRecoveryRequired(false);
  maintenance.setSettingsRestoreRecoveryRequired(false);
});
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(await fs.realpath(process.env.ORBIS_CORE_CAPTURE_TEST_DIR ?? os.tmpdir()), 'co-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const captureDir = path.join(dataDir, 'backups/time-machine/core-capture');
  await fs.mkdir(captureDir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const reservationId = randomUUID();
  const controller = { id: h('e'), imageId: `sha256:${h('f')}`, startedAt: '2026-11-06T00:00:00Z', definitionSha256: h('0') };
  const marker = {
    schema: 'orbis.core-capture-source-hold.v2',
    id,
    operatorAuthorizationId: randomUUID(),
    drainReservationId: reservationId,
    preparationSha256: h('1'),
    sourceSha256: h('a'),
    pointReservationSha256: h('d'),
    controller: { ...controller, startedAt: 'before restart' },
    queueDrain: {
      pauseId: reservationId,
      generation: 1,
      queues: ['app-events-queue', 'repo-queue', 'system-events-queue'].map((name) => ({ name, messages: 0, consumers: 0 })),
    },
  };
  const markerFile = path.join(captureDir, 'source-hold.json');
  const markerBytes = Buffer.from(canonicalPublicationJson(marker));
  await fs.writeFile(markerFile, markerBytes, { mode: 0o600 });
  const binding = { id, sourceSha256: h('a'), sourceHoldSha256: createHash('sha256').update(markerBytes).digest('hex') };
  const ready = {
    version: 1 as const,
    ...binding,
    state: 'verified-awaiting-continuation' as const,
    completionSha256: h('c'),
    pointReservationSha256: h('d'),
    controller,
  };
  const state = { reply: ready as unknown };
  const socket = path.join(root, 's');
  const server = http.createServer(async (request, response) => {
    for await (const _ of request) {
      /* drain request */
    }
    const body = JSON.stringify(state.reply);
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
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
  const client = new clientModule.HostCoreCaptureCompletionClient(socket);
  const queues = {
    queueGeneration: 2,
    queues: ['app-events-queue', 'repo-queue', 'system-events-queue'].map((name) => ({ name, messages: 0, consumers: 1 })),
    recheck: vi.fn(async () => {}),
  };
  return { root, dataDir, captureDir, markerFile, markerBytes, binding, ready, state, client, queues };
}
const blocked = () => {
  expect(maintenance.backupMaintenanceActive()).toBe(true);
  expect(maintenance.backupMaintenanceOutsideResetActive()).toBe(true);
  expect(maintenance.enterBackupMutation()).toBeNull();
  const next = vi.fn();
  const response = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
  for (const originalUrl of ['/api/tasks', '/api/system-backups', '/api/sse/app']) {
    maintenance.backupMaintenanceMiddleware({ method: 'GET', originalUrl } as never, response as never, next);
    expect(response.status).toHaveBeenLastCalledWith(503);
  }
  expect(next).not.toHaveBeenCalled();
};

it('initializes only with a consumed root grant and settles only the same completed approval', async () => {
  const f = await fixture();
  maintenance.holdCoreCaptureRecovery();
  const release = await maintenance.acquireBackupMaintenance(signal());
  const token = await f.client.prepare(f.binding, signal());
  await maintenance.initializeCoreCaptureRecovery(token, async (details) => {
    expect(details).toEqual(f.ready);
    expect(maintenance.coreCaptureRecoveryRequired()).toBe(false);
    blocked();
  });
  blocked();
  f.state.reply = { ...f.ready, state: 'complete', continuationSha256: h('2'), controller: { ...f.ready.controller, startedAt: 'other frame' } };
  await expect(maintenance.settleCoreCaptureRecovery(await f.client.prepare(f.binding, signal()))).rejects.toThrow();
  blocked();
  f.state.reply = { ...f.ready, state: 'complete', continuationSha256: h('2') };
  maintenance.setBackupRecoveryRequired(true);
  await expect(maintenance.settleCoreCaptureRecovery(await f.client.prepare(f.binding, signal()))).rejects.toThrow();
  maintenance.setBackupRecoveryRequired(false);
  await expect(maintenance.settleCoreCaptureRecovery(await f.client.prepare(f.binding, signal()), h('3'))).rejects.toThrow();
  blocked();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(maintenance.settleCoreCaptureRecovery(await f.client.prepare(f.binding, signal()), h('2'), cancelled.signal)).rejects.toThrow();
  blocked();
  const duringVerification = new AbortController();
  vi.spyOn(duringVerification.signal, 'throwIfAborted').mockImplementationOnce(() => duringVerification.abort());
  await expect(
    maintenance.settleCoreCaptureRecovery(await f.client.prepare(f.binding, signal()), h('2'), duringVerification.signal),
  ).rejects.toThrow();
  blocked();
  await maintenance.settleCoreCaptureRecovery(await f.client.prepare(f.binding, signal()), h('2'));
  expect(maintenance.backupMaintenanceActive()).toBe(true);
  expect(maintenance.enterBackupMutation()).toBeNull();
  release();
  expect(maintenance.backupMaintenanceActive()).toBe(false);
  const mutation = maintenance.enterBackupMutation();
  expect(mutation).toBeTypeOf('function');
  mutation?.();
  await expect(maintenance.initializeCoreCaptureRecovery(token, async () => undefined)).rejects.toThrow();
});

it('rejects forged grants and initializer order violations without exposing normal APIs', async () => {
  const f = await fixture();
  maintenance.holdCoreCaptureRecovery();
  await expect(maintenance.initializeCoreCaptureRecovery({} as never, async () => undefined)).rejects.toThrow();
  blocked();
  const work = vi.fn();
  await expect(maintenance.initializeCoreCaptureRecovery(await f.client.prepare(f.binding, signal()), work)).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
  blocked();
  await maintenance.acquireBackupMaintenance(signal());
  await expect(maintenance.settleCoreCaptureRecovery(await f.client.prepare(f.binding, signal()))).rejects.toThrow();
  blocked();
});

it('keeps initialization failures sticky, including post-callback socket identity failure', async () => {
  const f = await fixture();
  maintenance.holdCoreCaptureRecovery();
  const release = await maintenance.acquireBackupMaintenance(signal());
  await expect(
    maintenance.initializeCoreCaptureRecovery(await f.client.prepare(f.binding, signal()), async () => {
      throw new Error('startup failed');
    }),
  ).rejects.toThrow('startup failed');
  release();
  blocked();
  expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
  await expect(maintenance.initializeCoreCaptureRecovery(await f.client.prepare(f.binding, signal()), async () => undefined)).rejects.toThrow();
  blocked();
});

it('retains initialization hold if the root socket changes after startup work', async () => {
  const f = await fixture();
  maintenance.holdCoreCaptureRecovery();
  const release = await maintenance.acquireBackupMaintenance(signal());
  await expect(
    maintenance.initializeCoreCaptureRecovery(await f.client.prepare(f.binding, signal()), async () => {
      await fs.chmod(path.join(f.root, 's'), 0o400);
    }),
  ).rejects.toThrow();
  release();
  blocked();
  expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
});

it('accepts a fresh already-complete grant for initializer and settlement after a lost finish response', async () => {
  const f = await fixture();
  maintenance.holdCoreCaptureRecovery();
  const release = await maintenance.acquireBackupMaintenance(signal());
  f.state.reply = { ...f.ready, state: 'complete', continuationSha256: h('2') };
  await maintenance.initializeCoreCaptureRecovery(await f.client.prepare(f.binding, signal()), async () => blocked());
  await maintenance.settleCoreCaptureRecovery(await f.client.prepare(f.binding, signal()));
  expect(maintenance.backupMaintenanceActive()).toBe(true);
  release();
  expect(maintenance.backupMaintenanceActive()).toBe(false);
});

it.skipIf(process.platform !== 'linux')(
  'writes immutable canonical continuation and preserves the source marker across identical retries',
  async () => {
    const f = await fixture();
    const marker = await subject.readCoreCaptureSourceHold(f.dataDir);
    expect(Object.isFrozen(marker)).toBe(true);
    expect(Object.isFrozen(marker.queueDrain.queues)).toBe(true);
    const written = await subject.writeCoreCaptureContinuation(f.dataDir, f.ready, f.queues, signal());
    const file = path.join(f.captureDir, f.binding.id, 'continuation-ready.json');
    const bytes = await fs.readFile(file);
    expect(written).toEqual({ id: f.binding.id, continuationSha256: createHash('sha256').update(bytes).digest('hex') });
    expect(bytes.toString()).toBe(
      canonicalPublicationJson({
        schema: 'orbis.core-capture-source-continuation.v1',
        id: f.binding.id,
        completionSha256: f.ready.completionSha256,
        sourceHoldSha256: f.binding.sourceHoldSha256,
        pointReservationSha256: h('d'),
        controller: f.ready.controller,
        queueGeneration: 2,
        queues: f.queues.queues,
      }),
    );
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    const inode = (await fs.stat(file)).ino;
    expect(await subject.writeCoreCaptureContinuation(f.dataDir, f.ready, f.queues, signal())).toEqual(written);
    expect((await fs.stat(file)).ino).toBe(inode);
    expect(await fs.readFile(f.markerFile)).toEqual(f.markerBytes);
    await expect(subject.writeCoreCaptureContinuation(f.dataDir, { ...f.ready, completionSha256: h('2') }, f.queues, signal())).rejects.toThrow();
    expect(await fs.readFile(file)).toEqual(bytes);
  },
);

it.skipIf(process.platform !== 'linux').each(['source', 'reservation', 'marker-replace', 'queues', 'generation', 'queue-failure'] as const)(
  'preserves source hold on %s failure',
  async (mode) => {
    const f = await fixture();
    let details = f.ready;
    if (mode === 'source') details = { ...f.ready, sourceHoldSha256: h('3') };
    if (mode === 'reservation') details = { ...f.ready, pointReservationSha256: h('3') };
    if (mode === 'marker-replace')
      f.queues.recheck.mockImplementationOnce(async () => {
        await fs.rename(f.markerFile, `${f.markerFile}.retained`);
        await fs.writeFile(f.markerFile, f.markerBytes, { mode: 0o600 });
      });
    if (mode === 'queues')
      f.queues.recheck.mockImplementationOnce(async () => {
        const first = f.queues.queues[0];
        if (!first) throw new Error('missing queue');
        first.messages = 1;
      });
    if (mode === 'generation')
      f.queues.recheck.mockImplementationOnce(async () => {
        f.queues.queueGeneration++;
      });
    if (mode === 'queue-failure') f.queues.recheck.mockRejectedValueOnce(new Error('queue changed'));
    await expect(subject.writeCoreCaptureContinuation(f.dataDir, details, f.queues, signal())).rejects.toThrow();
    expect(await fs.readFile(f.markerFile)).toEqual(f.markerBytes);
    await expect(fs.lstat(path.join(f.captureDir, f.binding.id, 'continuation-ready.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it.skipIf(process.platform !== 'linux')('preserves an ambiguous ready record when the post-write queue check fails', async () => {
  const f = await fixture();
  f.queues.recheck.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('lost queues'));
  await expect(subject.writeCoreCaptureContinuation(f.dataDir, f.ready, f.queues, signal())).rejects.toThrow('lost queues');
  expect(await fs.readFile(f.markerFile)).toEqual(f.markerBytes);
  expect((await fs.stat(path.join(f.captureDir, f.binding.id, 'continuation-ready.json'))).isFile()).toBe(true);
});

it.skipIf(process.platform !== 'linux').each(['symlink', 'linked', 'directory', 'bytes'] as const)(
  'does not overwrite an existing %s continuation',
  async (mode) => {
    const f = await fixture();
    const child = path.join(f.captureDir, f.binding.id);
    await fs.mkdir(child, { mode: 0o700 });
    const file = path.join(child, 'continuation-ready.json');
    const evidence = path.join(child, 'retained-evidence');
    await fs.writeFile(evidence, 'retained recovery evidence', { mode: 0o600 });
    if (mode === 'symlink') await fs.symlink(evidence, file);
    if (mode === 'linked') await fs.link(evidence, file);
    if (mode === 'directory') await fs.mkdir(file, { mode: 0o700 });
    if (mode === 'bytes') await fs.writeFile(file, 'unrelated previous evidence', { mode: 0o600 });
    const original = await fs.lstat(file);
    await expect(subject.writeCoreCaptureContinuation(f.dataDir, f.ready, f.queues, signal())).rejects.toThrow();
    expect((await fs.lstat(file)).ino).toBe(original.ino);
    expect(await fs.readFile(evidence, 'utf8')).toBe('retained recovery evidence');
    expect(await fs.readFile(f.markerFile)).toEqual(f.markerBytes);
  },
);

it.skipIf(process.platform !== 'linux')('refuses a replaced continuation directory during the final queue check', async () => {
  const f = await fixture();
  const child = path.join(f.captureDir, f.binding.id);
  f.queues.recheck.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
    await fs.rename(child, `${child}.retained`);
    await fs.mkdir(child, { mode: 0o700 });
  });
  await expect(subject.writeCoreCaptureContinuation(f.dataDir, f.ready, f.queues, signal())).rejects.toThrow();
  expect((await fs.stat(path.join(`${child}.retained`, 'continuation-ready.json'))).isFile()).toBe(true);
  expect(await fs.readdir(child)).toEqual([]);
  expect(await fs.readFile(f.markerFile)).toEqual(f.markerBytes);
});

it.skipIf(process.platform !== 'linux')('honors cancellation during queue verification before creating a ready record', async () => {
  const f = await fixture();
  const abort = new AbortController();
  f.queues.recheck.mockImplementationOnce(async () => {
    abort.abort();
  });
  await expect(subject.writeCoreCaptureContinuation(f.dataDir, f.ready, f.queues, abort.signal)).rejects.toThrow();
  await expect(fs.lstat(path.join(f.captureDir, f.binding.id, 'continuation-ready.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(f.markerFile)).toEqual(f.markerBytes);
});
