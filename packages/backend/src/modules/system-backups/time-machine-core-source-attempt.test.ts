import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CoreCaptureQueueSetup, QueueFactory } from '../queue/queue.factory';
import type { CoreCaptureAbortPreparation, VerifiedCoreAbortIntent } from '../host-updates/host-core-capture-abort-client';
let subject: typeof import('./time-machine-core-source-hold');
let maintenance: typeof import('@/common/backup-maintenance');
const roots: string[] = [];
beforeEach(async () => {
  vi.resetModules();
  subject = await import('./time-machine-core-source-hold');
  maintenance = await import('@/common/backup-maintenance');
});
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(scoped = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'attempt-')));
  roots.push(root);
  const prep: CoreCaptureAbortPreparation = {
    version: 3,
    id: randomUUID(),
    preparationSha256: 'a'.repeat(64),
    sourceSha256: 'b'.repeat(64),
    pointReservationSha256: 'c'.repeat(64),
    controller: { id: 'd'.repeat(64), imageId: `sha256:${'e'.repeat(64)}`, startedAt: '2026-11-06T00:00:00Z', definitionSha256: 'f'.repeat(64) },
  };
  const initial = {
    pauseId: randomUUID(),
    generation: 7,
    checkedAt: Date.now(),
    queues: (['app-events-queue', 'repo-queue', 'system-events-queue'] as const).map((name) => ({
      name,
      messages: 0 as const,
      consumers: 0 as const,
    })),
  };
  const release = vi.fn();
  const refusal = {
    setupId: randomUUID(),
    outcome: 'not-entered' as const,
    generation: 7,
    queues: initial.queues.map(({ name }) => ({ name, messages: 0 as const, consumers: 1 as const })),
  };
  const refusalRecheck = vi.fn(async () => {});
  const verifyRefusal = vi.fn<QueueFactory['verifyCoreCaptureSetupRefusal']>(async () => ({ ...refusal, recheck: refusalRecheck }));
  const pauseForBackup = vi.fn(async (_signal?: AbortSignal) => ({ initial, verify: vi.fn(async () => initial), release }));
  const queue = {
    pauseForBackup,
    resumeCoreCapturePause: vi.fn(),
    recheckCoreCapturePause: vi.fn<QueueFactory['recheckCoreCapturePause']>(async () => {
      throw new Error('No owned pause proof');
    }),
    verifyCoreCaptureSetupUnwind: vi.fn<QueueFactory['verifyCoreCaptureSetupUnwind']>(async () => {
      throw new Error('No owned unwind proof');
    }),
    ...(scoped
      ? {
          createCoreCaptureQueueSetup: vi.fn(
            () => Object.freeze({ pauseForBackup: (signal: AbortSignal) => pauseForBackup(signal) }) as unknown as CoreCaptureQueueSetup,
          ),
          verifyCoreCaptureSetupRefusal: verifyRefusal,
        }
      : {}),
  };
  const operator = randomUUID();
  const attempt = subject.createReservedCoreCaptureSourceAttempt(
    root,
    prep,
    operator,
    queue as unknown as Pick<QueueFactory, 'pauseForBackup' | 'resumeCoreCapturePause' | 'recheckCoreCapturePause' | 'verifyCoreCaptureSetupUnwind'>,
  );
  return { root, prep, initial, operator, attempt, queue, release, refusal, verifyRefusal, refusalRecheck };
}

it('retains only one source attempt for an original preparation and cannot mint a replacement unused attempt', async () => {
  const f = await fixture(true);
  expect(subject.createReservedCoreCaptureSourceAttempt(f.root, f.prep, f.operator, f.queue)).toBe(f.attempt);
  expect(() => subject.createReservedCoreCaptureSourceAttempt(f.root, f.prep, randomUUID(), f.queue)).toThrow();
  expect(() => subject.createReservedCoreCaptureSourceAttempt(f.root, f.prep, f.operator, { ...f.queue })).toThrow();
  expect(() =>
    subject.createReservedCoreCaptureSourceAttempt(f.root, { ...f.prep, preparationSha256: '0'.repeat(64) }, f.operator, f.queue),
  ).toThrow();
  await subject.stopReservedCoreCaptureSourceAttempt(f.attempt);
  expect(subject.createReservedCoreCaptureSourceAttempt(f.root, f.prep, f.operator, f.queue)).toBe(f.attempt);
  await expect(subject.startReservedCoreCaptureSourceAttempt(f.attempt, new AbortController().signal)).rejects.toThrow();
});

it('classifies a settled pre-queue refusal only with its factory scope and preserves foreign holds', async () => {
  const f = await fixture(true);
  const releaseOther = await maintenance.acquireBackupMaintenance(new AbortController().signal);
  maintenance.holdCoreCaptureRecovery();
  try {
    await expect(subject.startReservedCoreCaptureSourceAttempt(f.attempt, new AbortController().signal)).rejects.toThrow();
    const proof = await subject.stopReservedCoreCaptureSourceAttempt(f.attempt);
    expect(proof).toMatchObject({ kind: 'setup-refused', queueRefusal: f.refusal });
    expect(f.queue.pauseForBackup).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(maintenance.backupMaintenanceLeaseHeld()).toBe(true);
    expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
  } finally {
    releaseOther();
  }
});

it('does not rebind an already selected refused terminal to a different broker generation', async () => {
  const f = await fixture(true);
  const releaseOther = await maintenance.acquireBackupMaintenance(new AbortController().signal);
  try {
    await expect(subject.startReservedCoreCaptureSourceAttempt(f.attempt, new AbortController().signal)).rejects.toThrow();
    const stopped = await subject.stopReservedCoreCaptureSourceAttempt(f.attempt);
    expect(stopped.kind).toBe('setup-refused');
    if (stopped.kind !== 'setup-refused') throw new Error('Expected refused fixture');
    await subject.selectReservedCoreCaptureSetupRefusal(f.attempt, stopped, new AbortController().signal);
    f.verifyRefusal.mockResolvedValueOnce({ ...f.refusal, generation: 8, recheck: f.refusalRecheck });
    await expect(subject.stopReservedCoreCaptureSourceAttempt(f.attempt)).rejects.toThrow();
  } finally {
    releaseOther();
  }
});

it('refuses root abort before intent when setup-refused settlement support is absent', async () => {
  const f = await fixture(true);
  const releaseOther = await maintenance.acquireBackupMaintenance(new AbortController().signal);
  try {
    await expect(subject.startReservedCoreCaptureSourceAttempt(f.attempt, new AbortController().signal)).rejects.toThrow();
    const { HostCoreCaptureEmptyAbortClient } = await import('../host-updates/host-core-capture-empty-abort-client');
    const { HostCoreCaptureAbortClient } = await import('../host-updates/host-core-capture-abort-client');
    const { cancelReservedCoreCapture } = await import('./time-machine-core-early-abort');
    const client = new HostCoreCaptureEmptyAbortClient(path.join(f.root, 'absent-socket'));
    const intent = vi.spyOn(client, 'intent');
    await expect(
      cancelReservedCoreCapture(f.attempt, {
        preparation: f.prep,
        client,
        completeClient: new HostCoreCaptureAbortClient(path.join(f.root, 'absent-socket')),
        queue: f.queue,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(intent).not.toHaveBeenCalled();
    expect(maintenance.backupMaintenanceLeaseHeld()).toBe(true);
  } finally {
    releaseOther();
  }
});
it('retains its exact drain and mutation lease after draft failure without creating a marker', async () => {
  const f = await fixture();
  const error = new Error('draft refused');
  const started = subject.startReservedCoreCaptureSourceAttempt(f.attempt, new AbortController().signal, async () => {
    throw error;
  });
  await expect(started).rejects.toBe(error);
  expect(subject.coreCaptureSourceFailureWasUnwound(error)).toBe(false);
  expect(subject.startReservedCoreCaptureSourceAttempt(f.attempt, new AbortController().signal)).toBe(started);
  const stopped = await subject.stopReservedCoreCaptureSourceAttempt(f.attempt);
  expect(stopped).toMatchObject({
    kind: 'absent',
    operatorAuthorizationId: f.operator,
    drainReservationId: f.initial.pauseId,
    queueGeneration: 7,
    preparation: f.prep,
  });
  expect(stopped).not.toHaveProperty('release');
  expect(maintenance.backupMaintenanceLeaseHeld()).toBe(true);
  expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
  expect(f.release).not.toHaveBeenCalled();
  expect(f.queue.pauseForBackup).toHaveBeenCalledOnce();
  await expect(fs.lstat(path.join(f.root, 'backups/time-machine/core-capture/source-hold.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('waits for an admitted draft write to settle before reporting its controlled pre-marker phase', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const file = path.join(f.root, 'owned-draft');
  const original = new AbortController();
  const running = subject.startReservedCoreCaptureSourceAttempt(f.attempt, original.signal, async () => {
    entered.resolve();
    await gate.promise;
    await fs.writeFile(file, 'settled', { mode: 0o600 });
  });
  const rejected = expect(running).rejects.toThrow();
  await entered.promise;
  original.abort();
  const stopping = subject.stopReservedCoreCaptureSourceAttempt(f.attempt);
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  gate.resolve();
  await rejected;
  expect((await stopping).kind).toBe('absent');
  expect(await fs.readFile(file, 'utf8')).toBe('settled');
  expect(f.release).not.toHaveBeenCalled();
});
it('seals a never-started attempt without manufacturing a drain or a local lease', async () => {
  const f = await fixture();
  const unused = await subject.stopReservedCoreCaptureSourceAttempt(f.attempt);
  expect(unused).toMatchObject({ kind: 'unused', preparation: f.prep, operatorAuthorizationId: f.operator });
  expect(unused).not.toHaveProperty('drainReservationId');
  expect(unused).not.toHaveProperty('release');
  await expect(subject.startReservedCoreCaptureSourceAttempt(f.attempt, new AbortController().signal)).rejects.toThrow();
  expect(f.queue.pauseForBackup).not.toHaveBeenCalled();
  await expect(subject.stopReservedCoreCaptureSourceAttempt({} as typeof f.attempt)).rejects.toThrow();
  expect(maintenance.backupMaintenanceActive()).toBe(false);
});

it('leaves another operation’s maintenance and recovery holds unchanged when sealing unused work', async () => {
  const f = await fixture();
  const release = await maintenance.acquireBackupMaintenance(new AbortController().signal);
  maintenance.holdCoreCaptureRecovery();
  try {
    expect((await subject.stopReservedCoreCaptureSourceAttempt(f.attempt)).kind).toBe('unused');
    expect(maintenance.backupMaintenanceLeaseHeld()).toBe(true);
    expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
    expect(f.queue.pauseForBackup).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
  } finally {
    release();
  }
});

it('does not select root abort when unused-source settlement is unavailable', async () => {
  const f = await fixture();
  const { HostCoreCaptureEmptyAbortClient } = await import('../host-updates/host-core-capture-empty-abort-client');
  const { HostCoreCaptureAbortClient } = await import('../host-updates/host-core-capture-abort-client');
  const { cancelReservedCoreCapture } = await import('./time-machine-core-early-abort');
  const client = new HostCoreCaptureEmptyAbortClient(path.join(f.root, 'absent-socket'));
  const intent = vi.spyOn(client, 'intent');
  await expect(
    cancelReservedCoreCapture(f.attempt, {
      preparation: f.prep,
      client,
      completeClient: new HostCoreCaptureAbortClient(path.join(f.root, 'absent-socket')),
      queue: f.queue,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  expect(intent).not.toHaveBeenCalled();
  expect(f.queue.pauseForBackup).not.toHaveBeenCalled();
  expect(maintenance.backupMaintenanceActive()).toBe(false);
  await expect(fs.lstat(path.join(f.root, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('cannot write an unused terminal from a caller-created intent object', async () => {
  const f = await fixture();
  const { settleUnusedCoreCapture } = await import('./time-machine-core-unused-abort');
  const { HostCoreCaptureUnusedAbortClient } = await import('../host-updates/host-core-capture-unused-abort-client');
  const client = new HostCoreCaptureUnusedAbortClient(path.join(f.root, 'absent-socket'));
  const settle = vi.spyOn(client, 'settle');
  await expect(settleUnusedCoreCapture(f.attempt, {} as VerifiedCoreAbortIntent, client, new AbortController().signal)).rejects.toThrow();
  expect(settle).not.toHaveBeenCalled();
  expect(maintenance.backupMaintenanceActive()).toBe(false);
  await expect(fs.lstat(path.join(f.root, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('does not borrow another operation’s maintenance lease after admission is refused', async () => {
  const f = await fixture();
  const releaseOther = await maintenance.acquireBackupMaintenance(new AbortController().signal);
  try {
    await expect(subject.startReservedCoreCaptureSourceAttempt(f.attempt, new AbortController().signal)).rejects.toThrow();
    await expect(subject.stopReservedCoreCaptureSourceAttempt(f.attempt)).rejects.toThrow();
    expect(f.queue.pauseForBackup).not.toHaveBeenCalled();
    expect(maintenance.backupMaintenanceLeaseHeld()).toBe(true);
  } finally {
    releaseOther();
  }
  expect(maintenance.coreCaptureRecoveryRequired()).toBe(false);
});
it('cannot convert a failed queue reservation into a positive source terminal', async () => {
  const f = await fixture();
  f.queue.pauseForBackup.mockRejectedValueOnce(new Error('another pause'));
  await expect(subject.startReservedCoreCaptureSourceAttempt(f.attempt, new AbortController().signal)).rejects.toThrow('another pause');
  await expect(subject.stopReservedCoreCaptureSourceAttempt(f.attempt)).rejects.toThrow();
  expect(f.release).not.toHaveBeenCalled();
  expect(maintenance.backupMaintenanceActive()).toBe(false);
});

it('classifies fully settled setup only after fresh verification of its exact factory receipt', async () => {
  const f = await fixture();
  const failure = new Error('owned setup failure');
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  f.queue.pauseForBackup.mockImplementationOnce(async () => {
    entered.resolve();
    await gate.promise;
    throw failure;
  });
  const proof = {
    pauseId: f.initial.pauseId,
    generation: 7,
    queues: f.initial.queues.map((row) => ({ ...row, consumers: 1 as const })),
    recheck: vi.fn(async () => {}),
  };
  f.queue.verifyCoreCaptureSetupUnwind.mockImplementation(async (reference) => {
    expect(reference).toBe(failure);
    return proof;
  });
  const running = subject.startReservedCoreCaptureSourceAttempt(f.attempt, new AbortController().signal);
  const rejected = expect(running).rejects.toBe(failure);
  await entered.promise;
  let settled = false;
  const stopping = subject.stopReservedCoreCaptureSourceAttempt(f.attempt).then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(f.queue.verifyCoreCaptureSetupUnwind).not.toHaveBeenCalled();
  gate.resolve();
  await rejected;
  expect(await stopping).toMatchObject({ kind: 'setup-unwound', preparation: f.prep, queueUnwind: { pauseId: f.initial.pauseId, generation: 7 } });
  expect(proof.recheck).toHaveBeenCalledOnce();
  expect(maintenance.backupMaintenanceActive()).toBe(false);
  expect(f.release).not.toHaveBeenCalled();
  expect(subject.startReservedCoreCaptureSourceAttempt(f.attempt, new AbortController().signal)).toBe(running);
});

it('unwinds only its own returned pause when another operation wins the maintenance lease', async () => {
  const f = await fixture();
  let releaseOther: (() => void) | undefined;
  const pause = { initial: f.initial, verify: vi.fn(async () => f.initial), release: f.release };
  f.queue.pauseForBackup.mockImplementationOnce(async () => {
    releaseOther = await maintenance.acquireBackupMaintenance(new AbortController().signal);
    return pause;
  });
  f.queue.verifyCoreCaptureSetupUnwind.mockImplementation(async (reference) => {
    expect(reference).toBe(pause);
    return {
      pauseId: f.initial.pauseId,
      generation: 7,
      queues: f.initial.queues.map((row) => ({ ...row, consumers: 1 as const })),
      recheck: async () => {},
    };
  });
  try {
    await expect(subject.startReservedCoreCaptureSourceAttempt(f.attempt, new AbortController().signal)).rejects.toThrow('in progress');
    expect((await subject.stopReservedCoreCaptureSourceAttempt(f.attempt)).kind).toBe('setup-unwound');
    expect(f.release).toHaveBeenCalledOnce();
    expect(maintenance.backupMaintenanceLeaseHeld()).toBe(true);
    expect(maintenance.coreCaptureRecoveryRequired()).toBe(false);
  } finally {
    releaseOther?.();
  }
});

it('does not reclassify its own acquired maintenance lease when the following queue check fails', async () => {
  const f = await fixture();
  f.queue.pauseForBackup.mockResolvedValueOnce({
    initial: f.initial,
    release: f.release,
    verify: vi.fn(async () => {
      throw new Error('second check failed');
    }),
  });
  await expect(subject.startReservedCoreCaptureSourceAttempt(f.attempt, new AbortController().signal)).rejects.toThrow('second check failed');
  await expect(subject.stopReservedCoreCaptureSourceAttempt(f.attempt)).rejects.toThrow();
  expect(f.queue.verifyCoreCaptureSetupUnwind).not.toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
  expect(maintenance.backupMaintenanceLeaseHeld()).toBe(true);
  expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
});

it('recovers a missing drain only by rechecking the original still-held pause with a fresh signal', async () => {
  const f = await fixture();
  const pause = {
    initial: f.initial,
    release: f.release,
    verify: vi.fn(async () => {
      throw new Error('lost broker check');
    }),
  };
  f.queue.pauseForBackup.mockResolvedValueOnce(pause);
  const original = new AbortController();
  await expect(subject.startReservedCoreCaptureSourceAttempt(f.attempt, original.signal)).rejects.toThrow('lost broker check');
  original.abort();
  f.queue.recheckCoreCapturePause.mockResolvedValueOnce(f.initial);
  const recovery = new AbortController();
  expect(await subject.stopReservedCoreCaptureSourceAttempt(f.attempt, recovery.signal)).toMatchObject({
    kind: 'absent',
    drainReservationId: f.initial.pauseId,
    queueGeneration: f.initial.generation,
  });
  expect(f.queue.recheckCoreCapturePause).toHaveBeenCalledExactlyOnceWith(pause, recovery.signal);
  expect(f.queue.pauseForBackup).toHaveBeenCalledOnce();
  expect(f.queue.verifyCoreCaptureSetupUnwind).not.toHaveBeenCalled();
  expect(f.release).not.toHaveBeenCalled();
  expect(maintenance.backupMaintenanceLeaseHeld()).toBe(true);
  expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
});
