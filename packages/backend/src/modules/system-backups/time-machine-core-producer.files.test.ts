import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AuthService } from '../auth/auth.service';
import type { AccountSecurityService } from '../auth/account-security.service';
import type { HostCoreCaptureStartClient, PreparedCoreCaptureStart } from '../host-updates/host-core-capture-start-client';
import type { HostCoreCaptureReservedStartClient } from '../host-updates/host-core-capture-reserved-start-client';
import type { QueueFactory } from '../queue/queue.factory';
import type { StoredCoreTimeMachinePoint, TimeMachineCoreDraftMetadata } from './time-machine-store';

let subject: typeof import('./time-machine-core-producer');
let maintenance: typeof import('@/common/backup-maintenance');
let storage: typeof import('./time-machine-store');
let holds: typeof import('./time-machine-core-source-hold');
const roots: string[] = [];
const signal = () => new AbortController().signal;
const h = (v: string) => v.repeat(64);
beforeEach(async () => {
  vi.resetModules();
  subject = await import('./time-machine-core-producer');
  maintenance = await import('@/common/backup-maintenance');
  storage = await import('./time-machine-store');
  holds = await import('./time-machine-core-source-hold');
  maintenance.setBackupRecoveryRequired(false);
  maintenance.setRestoreRecoveryRequired(false);
  maintenance.setResetRecoveryRequired(false);
  maintenance.setSettingsRestoreRecoveryRequired(false);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { force: true, recursive: true });
});

function draft(point: StoredCoreTimeMachinePoint): TimeMachineCoreDraftMetadata {
  return {
    version: 3,
    kind: 'orbis-core',
    coreFormat: 'orbis.time-machine-core.v1',
    id: point.id,
    createdAt: point.createdAt,
    label: 'Core',
    source: 'manual',
    software: { orbis: '1', runtipi: '1', architecture: 'arm64' },
    coverage: {
      database: true,
      configuration: true,
      appearance: true,
      controllerConfiguration: true,
      controllerVersion: true,
      dockerImages: true,
      appData: false,
      cluster: 'local-only',
    },
    restore: { ready: false, blockers: [] },
    preview: { available: false, reason: { code: 'preview-not-captured', message: '' } },
    breakdown: [],
    excludedApps: [],
    restorePolicy: { managedApps: 'preserve-current', proxy: 'preserve-current', recoveryAuthority: 'preserve-current', queue: 'current-drained' },
    compatibility: { os: 'linux', architecture: 'arm64', database: { engine: 'postgresql', major: 17 }, storageFormat: 'physical-pgdata.v1' },
  };
}

async function fixture(requireProof = false, publisher?: 'sentinel.v1') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(process.env.ORBIS_CORE_CAPTURE_TEST_DIR ?? os.tmpdir(), 'producer-')));
  roots.push(root);
  const store = new storage.TimeMachineStore(root);
  const actor = { userId: 1, sessionBinding: 'session-1', securityBinding: 'security-1' };
  const policy = { revision: 1, requireCaptureAuthentication: requireProof, requireRestoreAuthentication: false };
  const auth = {
    operatorActionContext: vi.fn(async () => ({ ...actor })),
    verifySensitiveAction: vi.fn(async () => undefined),
  };
  const security = { read: vi.fn(async () => ({ ...policy })) };
  const request = {} as Request;
  const authorize = (credentials?: { password: string; totpCode?: string }) =>
    subject.authorizeCoreCaptureOperator({
      auth: auth as unknown as AuthService,
      security: security as unknown as AccountSecurityService,
      request,
      ownerId: 1,
      credentials,
    });
  const pauseId = randomUUID();
  const drained = {
    pauseId,
    generation: 1,
    checkedAt: Date.now(),
    queues: (['app-events-queue', 'repo-queue', 'system-events-queue'] as const).map((name) => ({
      name,
      messages: 0 as const,
      consumers: 0 as const,
    })),
  };
  const release = vi.fn();
  const verify = vi.fn(async () => drained);
  const pauseForBackup = vi.fn(async (_signal: AbortSignal) => ({ initial: drained, verify, release }));
  const token = Object.freeze({}) as PreparedCoreCaptureStart;
  const client = {
    requireCapability: vi.fn(async (_signal: AbortSignal) => undefined),
    prepare: vi.fn(async (id: string, reservation: string, _signal: AbortSignal) => ({
      token,
      publisher,
      preparation: {
        version: 2 as const,
        id,
        preparationSha256: h('a'),
        sourceSha256: h('b'),
        pointReservationSha256: reservation,
        controller: { id: h('c'), imageId: `sha256:${h('d')}`, startedAt: '2026-11-06T00:00:00Z', definitionSha256: h('e') },
      },
    })),
    admit: vi.fn(async (_token: PreparedCoreCaptureStart, _sourceHoldSha256: string, _signal: AbortSignal) => undefined),
  };
  const buildDraft = vi.fn(async (point: StoredCoreTimeMachinePoint, cancellation: AbortSignal) =>
    store.saveCoreDraft(point, draft(point), cancellation),
  );
  const onStage = vi.fn();
  const producer = (
    grant: import('./time-machine-core-producer').CoreCaptureOperatorGrant,
    overrides: Partial<ConstructorParameters<typeof subject.CoreCaptureProducer>[0]> = {},
  ) =>
    new subject.CoreCaptureProducer({
      dataDirectory: root,
      store,
      client: client as unknown as HostCoreCaptureStartClient,
      queue: { pauseForBackup } as unknown as Pick<QueueFactory, 'pauseForBackup'>,
      grant,
      buildDraft,
      onStage,
      ...overrides,
    });
  return {
    root,
    store,
    actor,
    policy,
    auth,
    security,
    authorize,
    client,
    pauseForBackup,
    release,
    verify,
    buildDraft,
    onStage,
    producer,
    markerFile: path.join(root, 'backups/time-machine/core-capture/source-hold.json'),
  };
}

it('persists the selected publisher before asking the queue to drain', async () => {
  const f = await fixture(false, 'sentinel.v1');
  const producer = f.producer(await f.authorize());
  const point = await producer.reserve(signal());
  f.pauseForBackup.mockImplementationOnce(async () => {
    const record = JSON.parse(await fs.readFile(path.join(f.root, 'backups/time-machine/core-capture', point.id, 'publisher.json'), 'utf8'));
    expect(record).toMatchObject({ id: point.id, publisher: 'sentinel.v1', preparationSha256: h('a'), sourceSha256: h('b') });
    expect(record.pointReservationSha256).toBe(f.client.prepare.mock.calls[0]?.[1]);
    throw new Error('Stopped before draining.');
  });
  await expect(producer.start(signal())).rejects.toThrow('Stopped before draining');
  expect(f.pauseForBackup).toHaveBeenCalledOnce();
  expect(f.client.admit).not.toHaveBeenCalled();
  expect((await f.store.load(point.id)).status).toBe('failed');
});

async function reservedFixture(publisher?: 'sentinel.v1') {
  const f = await fixture(false, publisher);
  const client = {
    ...f.client,
    preparationVersion: 3 as const,
    abortClients: {} as HostCoreCaptureReservedStartClient['abortClients'],
    prepare: vi.fn(async (id: string, reservation: string, cancellation: AbortSignal) => {
      const original = await f.client.prepare(id, reservation, cancellation);
      return {
        ...original,
        token: {} as Awaited<ReturnType<HostCoreCaptureReservedStartClient['prepare']>>['token'],
        preparation: { ...original.preparation, version: 3 as const },
      };
    }),
    admit: vi.fn(async () => undefined),
  };
  const queue = {
    pauseForBackup: f.pauseForBackup,
    resumeCoreCapturePause: vi.fn(),
    recheckCoreCapturePause: vi.fn(),
    verifyCoreCaptureSetupUnwind: vi.fn(),
    createCoreCaptureQueueSetup: vi.fn(() => ({ pauseForBackup: f.pauseForBackup })),
    verifyCoreCaptureSetupRefusal: vi.fn(),
  };
  const producer = async (overrides: Partial<ConstructorParameters<typeof subject.CoreCaptureProducer>[0]> = {}) =>
    f.producer(await f.authorize(), { client: client as unknown as HostCoreCaptureReservedStartClient, queue, ...overrides });
  return { ...f, client, queue, producer };
}

it('requires every reserved queue recovery API before host capability or point allocation', async () => {
  const f = await reservedFixture();
  const producer = await f.producer({ queue: { pauseForBackup: f.pauseForBackup } });
  await expect(producer.reserve(signal())).rejects.toThrow();
  expect(f.client.requireCapability).not.toHaveBeenCalled();
  expect(f.client.prepare).not.toHaveBeenCalled();
  expect(await f.store.list()).toEqual([]);
});

it('preserves the original point when reserved preparation remains uncertain', async () => {
  const f = await reservedFixture();
  const producer = await f.producer();
  const point = await producer.reserve(signal());
  f.client.prepare.mockRejectedValueOnce(new Error('Original preparation remains unsettled.'));
  await expect(producer.start(signal())).rejects.toThrow('unsettled');
  await expect(producer.start(signal())).rejects.toThrow('unsettled');
  expect(await f.store.load(point.id)).toEqual(point);
  expect(f.client.prepare).toHaveBeenCalledOnce();
  expect(f.pauseForBackup).not.toHaveBeenCalled();
});

it.each([true, false])(
  'retains the original attempt before publisher failure and fails the point only after positive abort (%s)',
  async (complete) => {
    const f = await reservedFixture('sentinel.v1');
    const earlyAbort = await import('./time-machine-core-early-abort');
    const attempt = {} as import('./time-machine-core-source-hold').ReservedCoreCaptureSourceAttempt;
    const create = vi.spyOn(holds, 'createReservedCoreCaptureSourceAttempt').mockReturnValue(attempt);
    const cancel = vi.spyOn(earlyAbort, 'cancelReservedCoreCapture');
    const producer = await f.producer();
    const point = await producer.reserve(signal());
    if (complete) cancel.mockResolvedValueOnce({ id: point.id, state: 'complete', sourceAttempt: 'not-started' });
    else cancel.mockRejectedValueOnce(new Error('Abort needs recovery.'));
    const directory = path.join(f.root, 'backups/time-machine/core-capture', point.id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o777);
    await expect(producer.start(signal())).rejects.toThrow();
    expect(create).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(
      attempt,
      expect.objectContaining({ preparation: expect.objectContaining({ version: 3, id: point.id }), queue: f.queue }),
    );
    expect((await f.store.load(point.id)).status).toBe(complete ? 'failed' : 'capturing');
    expect(f.pauseForBackup).not.toHaveBeenCalled();
    expect(f.client.admit).not.toHaveBeenCalled();
  },
);

it('uses an independent cleanup signal after caller cancellation and preserves a changed point', async () => {
  const f = await reservedFixture();
  const earlyAbort = await import('./time-machine-core-early-abort');
  const caller = new AbortController();
  const error = new Error('Draft canceled.');
  const producer = await f.producer();
  const point = await producer.reserve(signal());
  const changed = { ...point, createdAt: point.createdAt + 1 };
  const start = vi.spyOn(holds, 'startReservedCoreCaptureSourceAttempt').mockImplementationOnce(async () => {
    await f.store.update(changed);
    caller.abort();
    throw error;
  });
  const cancel = vi.spyOn(earlyAbort, 'cancelReservedCoreCapture').mockImplementationOnce(async (_attempt, options) => {
    expect(options.signal).not.toBe(caller.signal);
    expect(options.signal.aborted).toBe(false);
    return { id: point.id, state: 'complete', sourceAttempt: 'not-started' };
  });
  await expect(producer.start(caller.signal)).rejects.toBe(error);
  expect(start).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  expect(await f.store.load(point.id)).toEqual(changed);
});

it.skipIf(process.platform !== 'linux').each([false, true])(
  'reserved producer retains the real source hold after admission (uncertain=%s)',
  async (uncertain) => {
    const f = await reservedFixture();
    const earlyAbort = await import('./time-machine-core-early-abort');
    const cancel = vi.spyOn(earlyAbort, 'cancelReservedCoreCapture');
    const producer = await f.producer();
    const point = await producer.reserve(signal());
    if (uncertain) f.client.admit.mockRejectedValueOnce(Object.assign(new Error('Admission lost.'), { code: 'ECONNRESET' }));
    if (uncertain) await expect(producer.start(signal())).rejects.toThrow('Admission lost');
    else await producer.start(signal());
    const marker = await holds.readCoreCaptureSourceHold(f.root);
    expect(marker.id).toBe(point.id);
    expect(marker.pointReservationSha256).toBe(f.client.prepare.mock.calls[0]?.[1]);
    expect(f.client.admit).toHaveBeenCalledOnce();
    expect(f.buildDraft).toHaveBeenCalledOnce();
    expect((await f.store.load(point.id)).status).toBe('capturing');
    expect(f.release).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
  },
);

it('rejects unsafe publisher storage before draining or admission', async () => {
  const f = await fixture(false, 'sentinel.v1');
  const producer = f.producer(await f.authorize());
  const point = await producer.reserve(signal());
  const directory = path.join(f.root, 'backups/time-machine/core-capture', point.id);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o777);
  await expect(producer.start(signal())).rejects.toThrow();
  expect(f.pauseForBackup).not.toHaveBeenCalled();
  expect(f.client.admit).not.toHaveBeenCalled();
  await expect(fs.lstat(path.join(directory, 'publisher.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('denies forged and already consumed grants without allocating a second point', async () => {
  const f = await fixture();
  await expect(f.producer({} as never).reserve(signal())).rejects.toThrow();
  expect(await f.store.list()).toEqual([]);
  expect(f.client.requireCapability).not.toHaveBeenCalled();
  const grant = await f.authorize();
  const producer = f.producer(grant);
  const reserved = await producer.reserve(signal());
  expect(await producer.reserve(signal())).toEqual(reserved);
  await expect(f.producer(grant).reserve(signal())).rejects.toThrow();
  expect((await f.store.list()).map((point) => point.id)).toEqual([reserved.id]);
  expect(f.client.requireCapability).toHaveBeenCalledOnce();
});

it('denies missing proofs under opted-in policy before capability or storage allocation', async () => {
  const f = await fixture(true);
  await expect(f.authorize()).rejects.toThrow('password');
  expect(f.auth.verifySensitiveAction).not.toHaveBeenCalled();
  expect(f.client.requireCapability).not.toHaveBeenCalled();
  expect(await f.store.list()).toEqual([]);
});

it.each([false, true])('uses the real policy authorization once and rechecks context without repeated proofs (policy=%s)', async (requireProof) => {
  const f = await fixture(requireProof);
  const grant = await f.authorize(requireProof ? { password: 'local-test-password', totpCode: '123456' } : undefined);
  const producer = f.producer(grant);
  const point = await producer.reserve(signal());
  const error = new Error('Root preparation unavailable.');
  f.client.prepare.mockRejectedValueOnce(error);
  await expect(producer.start(signal())).rejects.toBe(error);
  expect(f.auth.verifySensitiveAction).toHaveBeenCalledTimes(requireProof ? 1 : 0);
  if (requireProof) expect(f.auth.verifySensitiveAction).toHaveBeenCalledWith(1, 'local-test-password', '123456');
  expect(f.auth.operatorActionContext.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect((await f.store.load(point.id)).status).toBe('failed');
  expect(f.pauseForBackup).not.toHaveBeenCalled();
  expect(f.client.admit).not.toHaveBeenCalled();
  expect(maintenance.backupMaintenanceActive()).toBe(false);
});

it('rejects missing host capability before creating a point and consumes the grant', async () => {
  const f = await fixture();
  const grant = await f.authorize();
  f.client.requireCapability.mockRejectedValueOnce(new Error('Capability unavailable.'));
  await expect(f.producer(grant).reserve(signal())).rejects.toThrow('Capability unavailable');
  expect(await f.store.list()).toEqual([]);
  await expect(f.producer(grant).reserve(signal())).rejects.toThrow();
  expect(f.client.requireCapability).toHaveBeenCalledOnce();
});

it.each(['reserve', 'start', 'before-drain', 'after-drain'] as const)(
  'rejects session revocation at %s without submitting admission',
  async (phase) => {
    const f = await fixture();
    const producer = f.producer(await f.authorize());
    if (phase === 'reserve') {
      f.actor.sessionBinding = 'revoked';
      await expect(producer.reserve(signal())).rejects.toThrow('session');
      expect(await f.store.list()).toEqual([]);
    } else {
      const point = await producer.reserve(signal());
      if (phase === 'start') f.actor.sessionBinding = 'revoked';
      if (phase === 'before-drain') {
        const prepare = f.client.prepare.getMockImplementation();
        if (!prepare) throw new Error('Missing preparation fixture.');
        f.client.prepare.mockImplementationOnce(async (...args) => {
          const approved = await prepare(...args);
          f.actor.sessionBinding = 'revoked';
          return approved;
        });
      }
      if (phase === 'after-drain') {
        const pause = f.pauseForBackup.getMockImplementation();
        if (!pause) throw new Error('Missing queue fixture.');
        f.pauseForBackup.mockImplementationOnce(async (...args) => {
          const result = await pause(...args);
          f.actor.sessionBinding = 'revoked';
          return result;
        });
      }
      await expect(producer.start(signal())).rejects.toThrow('session');
      expect((await f.store.load(point.id)).status).toBe('failed');
    }
    expect(f.pauseForBackup).toHaveBeenCalledTimes(phase === 'after-drain' ? 1 : 0);
    expect(f.release).toHaveBeenCalledTimes(phase === 'after-drain' ? 1 : 0);
    expect(f.buildDraft).not.toHaveBeenCalled();
    expect(f.client.admit).not.toHaveBeenCalled();
    expect(maintenance.backupMaintenanceActive()).toBe(false);
    await expect(fs.lstat(f.markerFile)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it('unwinds queue and maintenance when draft creation fails after draining but before marker creation', async () => {
  const f = await fixture();
  const producer = f.producer(await f.authorize());
  const point = await producer.reserve(signal());
  const error = new Error('Draft storage unavailable.');
  f.buildDraft.mockImplementationOnce(async () => {
    expect(maintenance.backupMaintenanceActive()).toBe(true);
    expect(f.pauseForBackup).toHaveBeenCalledOnce();
    throw error;
  });
  await expect(producer.start(signal())).rejects.toBe(error);
  expect(holds.coreCaptureSourceFailureWasUnwound(error)).toBe(true);
  expect(holds.coreCaptureSourceFailureWasUnwound(new Error(error.message))).toBe(false);
  expect((await f.store.load(point.id)).status).toBe('failed');
  expect(f.release).toHaveBeenCalledOnce();
  expect(maintenance.backupMaintenanceActive()).toBe(false);
  expect(maintenance.coreCaptureRecoveryRequired()).toBe(false);
  expect(f.client.admit).not.toHaveBeenCalled();
  await expect(fs.lstat(f.markerFile)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(producer.start(signal())).rejects.toBe(error);
  expect(f.buildDraft).toHaveBeenCalledOnce();
  expect(f.release).toHaveBeenCalledOnce();
});

it.skipIf(process.platform !== 'linux').each([false, true])(
  'writes a real encrypted draft and admits only once while retaining the source hold (policy=%s)',
  async (requireProof) => {
    const f = await fixture(requireProof);
    const producer = f.producer(await f.authorize(requireProof ? { password: 'local-test-password' } : undefined));
    const point = await producer.reserve(signal());
    await Promise.all([producer.start(signal()), producer.start(signal())]);
    expect(f.client.admit).toHaveBeenCalledOnce();
    expect(f.buildDraft).toHaveBeenCalledOnce();
    expect(f.auth.verifySensitiveAction).toHaveBeenCalledTimes(requireProof ? 1 : 0);
    expect(await f.store.readCoreDraft(point, signal())).toEqual(draft(point));
    const bytes = await fs.readFile(f.markerFile);
    const marker = await holds.readCoreCaptureSourceHold(f.root);
    expect(marker.id).toBe(point.id);
    expect(marker.schema).toBe('orbis.core-capture-source-hold.v2');
    expect(marker.pointReservationSha256).toBe(f.client.prepare.mock.calls[0]?.[1]);
    expect(f.client.admit.mock.calls[0]?.[1]).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(f.onStage.mock.calls.flat()).toEqual(['preparing', 'saving-preview', 'capturing-core']);
    expect((await f.store.load(point.id)).status).toBe('capturing');
    expect(maintenance.backupMaintenanceActive()).toBe(true);
    expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
    expect(f.release).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform !== 'linux')('preserves the marker, draft, point and queue hold after an uncertain admission without replay', async () => {
  const f = await fixture();
  const producer = f.producer(await f.authorize());
  const point = await producer.reserve(signal());
  const error = Object.assign(new Error('Admission response lost.'), { code: 'ECONNRESET' });
  f.client.admit.mockRejectedValueOnce(error);
  await expect(producer.start(signal())).rejects.toBe(error);
  const bytes = await fs.readFile(f.markerFile);
  const inode = (await fs.stat(f.markerFile)).ino;
  expect((await f.store.load(point.id)).status).toBe('capturing');
  expect(await f.store.readCoreDraft(point, signal())).toEqual(draft(point));
  expect(holds.coreCaptureSourceFailureWasUnwound(error)).toBe(false);
  await expect(producer.start(signal())).rejects.toBe(error);
  expect(f.client.admit).toHaveBeenCalledOnce();
  expect(f.client.prepare).toHaveBeenCalledOnce();
  expect(f.buildDraft).toHaveBeenCalledOnce();
  expect(await fs.readFile(f.markerFile)).toEqual(bytes);
  expect((await fs.stat(f.markerFile)).ino).toBe(inode);
  expect(maintenance.backupMaintenanceActive()).toBe(true);
  expect(maintenance.coreCaptureRecoveryRequired()).toBe(true);
  expect(f.release).not.toHaveBeenCalled();
});

it('requires the draft to have actually persisted before marker creation and safely unwinds a missing draft', async () => {
  const f = await fixture();
  const producer = f.producer(await f.authorize());
  const point = await producer.reserve(signal());
  f.buildDraft.mockResolvedValueOnce(undefined);
  await expect(producer.start(signal())).rejects.toThrow();
  expect((await f.store.load(point.id)).status).toBe('failed');
  expect(f.release).toHaveBeenCalledOnce();
  expect(maintenance.backupMaintenanceActive()).toBe(false);
  expect(maintenance.coreCaptureRecoveryRequired()).toBe(false);
  expect(f.client.admit).not.toHaveBeenCalled();
  await expect(fs.lstat(f.markerFile)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves a changed point reservation when preparation fails instead of overwriting it as failed', async () => {
  const f = await fixture();
  const producer = f.producer(await f.authorize());
  const point = await producer.reserve(signal());
  const changed = { ...point, createdAt: point.createdAt + 1 };
  const error = new Error('Preparation response lost after reservation changed.');
  f.client.prepare.mockImplementationOnce(async () => {
    await f.store.update(changed);
    throw error;
  });
  await expect(producer.start(signal())).rejects.toBe(error);
  expect(await f.store.load(point.id)).toEqual(changed);
  expect(f.pauseForBackup).not.toHaveBeenCalled();
  expect(f.buildDraft).not.toHaveBeenCalled();
  expect(f.client.admit).not.toHaveBeenCalled();
  expect(maintenance.backupMaintenanceActive()).toBe(false);
});
