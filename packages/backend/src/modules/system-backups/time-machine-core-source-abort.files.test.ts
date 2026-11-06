import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { QueueFactory } from '../queue/queue.factory';
import type { CoreCaptureAbortPreparation, VerifiedCoreAbortIntent, VerifiedCoreAbortComplete } from '../host-updates/host-core-capture-abort-client';

let subject: typeof import('./time-machine-core-source-hold');
let clientModule: typeof import('../host-updates/host-core-capture-abort-client');
let maintenance: typeof import('@/common/backup-maintenance');
const cleanup: (() => Promise<unknown>)[] = [];
beforeEach(async () => {
  vi.resetModules();
  subject = await import('./time-machine-core-source-hold');
  clientModule = await import('../host-updates/host-core-capture-abort-client');
  maintenance = await import('@/common/backup-maintenance');
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const hash = (value: string) => value.repeat(64);
const signal = () => new AbortController().signal;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sa-')));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  await fs.mkdir(path.join(data, 'backups/time-machine'), { recursive: true, mode: 0o700 });
  const ipc = path.join(root, 'ipc');
  await fs.mkdir(ipc, { mode: 0o700 });
  const socket = path.join(ipc, 's');
  const preparation: CoreCaptureAbortPreparation = {
    version: 3,
    id: randomUUID(),
    preparationSha256: hash('a'),
    sourceSha256: hash('b'),
    pointReservationSha256: hash('c'),
    controller: { id: hash('d'), imageId: `sha256:${hash('e')}`, startedAt: '2026-11-06T00:00:00Z', definitionSha256: hash('f') },
  };
  const initial = {
    pauseId: randomUUID(),
    generation: 1,
    checkedAt: Date.now(),
    queues: ['app-events-queue', 'repo-queue', 'system-events-queue'].map((name) => ({ name, messages: 0 as const, consumers: 0 as const })),
  };
  const release = vi.fn();
  const verify = vi.fn(async () => initial);
  const checkReady = vi.fn(async () => {});
  const queue = {
    pauseForBackup: vi.fn(async () => ({ initial, release, verify })),
    resumeCoreCapturePause: vi.fn(async () => {
      release();
      return {
        pauseId: initial.pauseId,
        queueGeneration: initial.generation,
        queues: initial.queues.map((row) => ({ ...row, consumers: 1 as const })),
        recheck: checkReady,
      };
    }),
  };
  const source = await subject.prepareCoreCaptureSourceHold(
    data,
    {
      id: preparation.id,
      preparationSha256: preparation.preparationSha256,
      sourceSha256: preparation.sourceSha256,
      pointReservationSha256: preparation.pointReservationSha256,
      controller: preparation.controller,
      operatorAuthorizationId: randomUUID(),
    },
    queue as unknown as Pick<QueueFactory, 'pauseForBackup'>,
    signal(),
  );
  const directory = path.join(data, 'backups/time-machine/core-capture');
  const marker = path.join(directory, 'source-hold.json');
  const pointDir = path.join(directory, preparation.id);
  const state = { retirement: 'rename', afterReply: async () => {} };
  let approval: Record<string, unknown> | undefined;
  const server = http.createServer(async (request, response) => {
    try {
      const parts: Buffer[] = [];
      for await (const raw of request) parts.push(Buffer.from(raw));
      const body = JSON.parse(Buffer.concat(parts).toString());
      let value: unknown;
      if (request.url?.includes('/abort-intent'))
        value = { version: 1, id: preparation.id, state: 'abort-intent', preparationSha256: hash('a'), decisionSha256: hash('0') };
      else if (request.url?.endsWith('/abort-prepare')) {
        const bytes = await fs.readFile(path.join(pointDir, 'abort-terminal.json'));
        if (digest(bytes) !== body.terminalSha256) throw new Error('fixture terminal mismatch');
        approval = {
          version: 1,
          id: preparation.id,
          state: 'verified-abort-awaiting-continuation',
          preparationSha256: hash('a'),
          decisionSha256: hash('0'),
          terminalSha256: body.terminalSha256,
          approvalSha256: hash('2'),
          sourceSha256: hash('b'),
          sourceHoldSha256: source.sourceHoldSha256,
          pointReservationSha256: hash('c'),
          controller: preparation.controller,
        };
        value = approval;
      } else {
        const ready = await fs.readFile(path.join(pointDir, 'abort-continuation-ready.json'));
        if (digest(ready) !== body.continuationSha256) throw new Error('fixture continuation mismatch');
        const retired = path.join(directory, `source-hold-retired-${preparation.id}.json`);
        if (state.retirement === 'rename') await fs.rename(marker, retired);
        if (state.retirement === 'copy') {
          await fs.copyFile(marker, retired);
          await fs.unlink(marker);
        }
        value = { ...approval, state: 'complete', continuationSha256: body.continuationSha256 };
      }
      const bytes = Buffer.from(JSON.stringify(value));
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': bytes.length });
      await state.afterReply();
      response.end(bytes);
    } catch {
      response.writeHead(409);
      response.end();
    }
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
  const client = new clientModule.HostCoreCaptureAbortClient(socket);
  const terminal = async () => {
    const intent = await client.intent(preparation, signal());
    return subject.sealCoreCaptureSourceForAbort(source, intent.token, signal());
  };
  const prepared = async () => {
    const stopped = await terminal();
    return client.prepare(preparation, hash('0'), stopped.terminalSha256, source.sourceHoldSha256, signal());
  };
  return { source, client, preparation, queue, release, verify, checkReady, state, marker, pointDir, socket, terminal, prepared };
}

it('rejects fabricated source and completion capabilities without changing maintenance state', async () => {
  const source = {} as Awaited<ReturnType<typeof subject.prepareCoreCaptureSourceHold>>;
  await expect(subject.sealCoreCaptureSourceForAbort(source, {} as VerifiedCoreAbortIntent, signal())).rejects.toThrow();
  await expect(subject.settleCoreCaptureSourceAbort(source, {} as VerifiedCoreAbortComplete, signal())).rejects.toThrow();
  expect(maintenance.coreCaptureRecoveryRequired()).toBe(false);
});

it.skipIf(process.platform !== 'linux')(
  'settles only the exact committed cancellation after resumption and preserved marker retirement',
  async () => {
    const f = await fixture();
    const original = await fs.stat(f.marker);
    const approval = await f.prepared();
    const ready = await subject.resumeCoreCaptureSourceAfterAbort(f.source, approval.token, f.queue, signal());
    expect(f.queue.resumeCoreCapturePause).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(maintenance.backupMaintenanceLeaseHeld()).toBe(true);
    expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
    const done = await f.client.finish(approval.details, ready.continuationSha256, signal());
    await subject.settleCoreCaptureSourceAbort(f.source, done.token, signal());
    expect(f.release).toHaveBeenCalledOnce();
    expect(maintenance.backupMaintenanceActive()).toBe(false);
    const retired = await fs.stat(path.join(path.dirname(f.marker), `source-hold-retired-${f.preparation.id}.json`));
    expect(retired.ino).toBe(original.ino);
    await expect(subject.settleCoreCaptureSourceAbort(f.source, done.token, signal())).rejects.toThrow();
  },
);

it.skipIf(process.platform !== 'linux')('waits for an active handoff before witnessing a stopped producer and rejects later submission', async () => {
  const f = await fixture();
  const pending = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const running = f.source.handoff(async () => {
    entered.resolve();
    await pending.promise;
    throw new Error('fixture submission refused');
  });
  const rejection = expect(running).rejects.toThrow('fixture submission refused');
  await entered.promise;
  const intent = await f.client.intent(f.preparation, signal());
  const sealed = subject.sealCoreCaptureSourceForAbort(f.source, intent.token, signal());
  await expect(f.source.handoff(async () => undefined)).rejects.toThrow();
  await expect(fs.lstat(path.join(f.pointDir, 'abort-terminal.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  pending.resolve();
  await rejection;
  await sealed;
  expect(JSON.parse(await fs.readFile(path.join(f.pointDir, 'abort-terminal.json'), 'utf8')).queueGeneration).toBe(1);
  expect(f.queue.resumeCoreCapturePause).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== 'linux').each(['copy', 'leave'])(
  'retains both holds when reported cleanup did not preserve the marker (%s)',
  async (retirement) => {
    const f = await fixture();
    f.state.retirement = retirement;
    const approval = await f.prepared();
    const ready = await subject.resumeCoreCaptureSourceAfterAbort(f.source, approval.token, f.queue, signal());
    const done = await f.client.finish(approval.details, ready.continuationSha256, signal());
    await expect(subject.settleCoreCaptureSourceAbort(f.source, done.token, signal())).rejects.toThrow();
    expect(maintenance.backupMaintenanceLeaseHeld()).toBe(true);
    expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
  },
);

it.skipIf(process.platform !== 'linux')('never produces continuation evidence after a partial queue restart or retries the starts', async () => {
  const f = await fixture();
  const approved = await f.prepared();
  f.queue.resumeCoreCapturePause.mockRejectedValueOnce(new Error('fixture partial restart'));
  await expect(subject.resumeCoreCaptureSourceAfterAbort(f.source, approved.token, f.queue, signal())).rejects.toThrow('partial restart');
  const again = await f.client.prepare(f.preparation, hash('0'), approved.details.terminalSha256, f.source.sourceHoldSha256, signal());
  await expect(subject.resumeCoreCaptureSourceAfterAbort(f.source, again.token, f.queue, signal())).rejects.toThrow('partial restart');
  expect(f.queue.resumeCoreCapturePause).toHaveBeenCalledOnce();
  await expect(fs.lstat(path.join(f.pointDir, 'abort-continuation-ready.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(maintenance.backupMaintenanceLeaseHeld()).toBe(true);
});

it.skipIf(process.platform !== 'linux')('refuses substituted terminal evidence before resuming any queue', async () => {
  const f = await fixture();
  const approved = await f.prepared();
  await fs.writeFile(path.join(f.pointDir, 'abort-terminal.json'), '{}');
  await expect(subject.resumeCoreCaptureSourceAfterAbort(f.source, approved.token, f.queue, signal())).rejects.toThrow();
  expect(f.queue.resumeCoreCapturePause).not.toHaveBeenCalled();
  expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
});
