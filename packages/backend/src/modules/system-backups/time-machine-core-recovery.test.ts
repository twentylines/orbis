import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { CoreCaptureRecovery } from './time-machine-core-recovery';
import { rememberCoreCapturePublisher } from './time-machine-core-publisher';

const state = vi.hoisted(() => ({
  held: false,
  capture: true,
  marker: {} as Record<string, unknown>,
  point: {} as Record<string, unknown>,
  rootState: 'verified-awaiting-continuation',
  events: [] as string[],
  release: vi.fn(),
  load: vi.fn(),
  readDraft: vi.fn(),
  status: vi.fn(),
  prepareDownload: vi.fn(),
  completion: vi.fn(),
  finish: vi.fn(),
  save: vi.fn(),
  negotiatePublication: vi.fn(),
  publicationStatus: vi.fn(),
  preparePublication: vi.fn(),
  downloadPublication: vi.fn(),
  adopt: vi.fn(),
  writeContinuation: vi.fn(),
  cleanupWarning: vi.fn(),
}));
vi.mock('node:timers/promises', () => ({
  setTimeout: (delay: number, value: unknown, options?: { signal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const signal = options?.signal;
      signal?.throwIfAborted();
      const cancelled = () => {
        clearTimeout(timer);
        reject(new Error('Retry wait cancelled.'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', cancelled);
        resolve(value);
      }, delay);
      signal?.addEventListener('abort', cancelled, { once: true });
    }),
}));
vi.mock('@/common/backup-maintenance', () => ({
  coreCaptureRecoveryRequired: () => state.capture,
  holdCoreCaptureRecovery: () => {
    state.capture = true;
  },
  backupMaintenanceActive: () => state.held,
  acquireBackupMaintenance: async () => {
    state.held = true;
    return () => {
      state.release();
      state.held = false;
    };
  },
  initializeCoreCaptureRecovery: async (grant: { details: object }, work: (details: object) => Promise<void>) => {
    state.events.push('initialize');
    state.capture = false;
    await work(grant.details);
  },
  settleCoreCaptureRecovery: async (grant: { details: { state: string; continuationSha256: string } }, expected: string) => {
    state.events.push('settle');
    if (grant.details.state !== 'complete' || grant.details.continuationSha256 !== expected) throw Error('Wrong continuation.');
  },
}));
vi.mock('@/common/installation-mode', () => ({ installationMode: () => ({ phase: 'normal' }) }));
vi.mock('./time-machine-core-source-hold', () => ({
  readCoreCaptureSourceHold: async () => structuredClone(state.marker),
  writeCoreCaptureContinuation: (...args: unknown[]) => state.writeContinuation(...args),
}));
vi.mock('./time-machine-store', () => ({
  TimeMachineStore: class {
    load = state.load;
    readCoreDraft = state.readDraft;
    adoptPublishedCorePoint = state.adopt;
  },
}));
vi.mock('../host-updates/host-core-capture-publication-client', () => ({
  HostCoreCapturePublicationClient: class {
    negotiate = state.negotiatePublication;
    status = state.publicationStatus;
    prepare = state.preparePublication;
    download = state.downloadPublication;
  },
}));
vi.mock('./time-machine-core-save', () => ({ saveCoreCapture: (...args: unknown[]) => state.save(...args) }));
vi.mock('../host-updates/host-core-capture-reader', () => ({
  HostCoreCaptureReader: class {
    status = state.status;
    prepare = state.prepareDownload;
  },
}));
vi.mock('../host-updates/host-core-capture-completion-client', () => ({
  HostCoreCaptureCompletionClient: class {
    prepare = state.completion;
    finish = state.finish;
  },
}));

const sha = (value: unknown) => createHash('sha256').update(canonicalPublicationJson(value)).digest('hex');
const realImmediate = globalThis.setImmediate;
async function waitForInitialStatus() {
  for (let count = 0; count < 1000; count++) {
    if (state.status.mock.calls.length) return;
    await new Promise<void>((resolve) => realImmediate(resolve));
  }
  throw new Error('Initial status read did not start.');
}
let directory: string;
const id = '11111111-1111-4111-8111-111111111111';
function approval(complete = false, continuation = 'f'.repeat(64)) {
  return {
    details: {
      state: complete ? 'complete' : 'verified-awaiting-continuation',
      pointReservationSha256: state.marker.pointReservationSha256,
      completionSha256: 'e'.repeat(64),
      continuationSha256: complete ? continuation : undefined,
    },
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.events = [];
  state.held = false;
  state.capture = true;
  state.rootState = 'verified-awaiting-continuation';
  directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'core-recovery-'));
  state.point = { version: 3, id, ownerId: 1, createdAt: 1, envelope: { version: 1, keyId: 'a'.repeat(64) }, status: 'capturing' };
  const { version, ownerId, createdAt, envelope } = state.point;
  state.marker = {
    schema: 'orbis.core-capture-source-hold.v2',
    id,
    sourceSha256: 'b'.repeat(64),
    preparationSha256: 'c'.repeat(64),
    controller: { id: 'd'.repeat(64), imageId: `sha256:${'e'.repeat(64)}`, startedAt: 'original', definitionSha256: 'f'.repeat(64) },
    pointReservationSha256: sha({ version, id, ownerId, createdAt, envelope }),
  };
  await fs.mkdir(path.join(directory, 'backups', 'time-machine', 'core-capture'), { mode: 0o700, recursive: true });
  state.load.mockImplementation(async () => structuredClone(state.point));
  state.readDraft.mockResolvedValue({ id, createdAt: 1 });
  state.status.mockResolvedValue({ state: 'resumed-awaiting-publication', ready: { artifact: { checkpoint: { bytes: 4096 } } } });
  state.prepareDownload.mockResolvedValue({});
  state.negotiatePublication.mockResolvedValue(false);
  state.preparePublication.mockResolvedValue({});
  state.adopt.mockImplementation(async () => {
    state.events.push('adopt');
    state.point.status = 'sealed';
  });
  state.save.mockImplementation(async () => {
    state.events.push('save');
    state.point.status = 'sealed';
  });
  state.completion.mockImplementation(async () => {
    state.events.push('approve');
    return approval(state.rootState === 'complete');
  });
  state.finish.mockImplementation(async () => {
    state.events.push('commit');
    return approval(true);
  });
  state.writeContinuation.mockImplementation(async () => {
    state.events.push('continuation');
    return { id, continuationSha256: 'f'.repeat(64) };
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(directory, { force: true, recursive: true });
});

function fixture() {
  const guarded = (name: string) =>
    vi.fn(async () => {
      expect(state.held).toBe(true);
      state.events.push(name);
    });
  const recheck = guarded('recheck');
  const queue = {
    resumeCoreCaptureConsumers: guarded('consumers'),
    verifyCoreCaptureConsumers: vi.fn(async () => ({
      queueGeneration: 1,
      queues: ['app-events-queue', 'repo-queue', 'system-events-queue'].map((name) => ({ name, messages: 0 as const, consumers: 1 as const })),
      recheck,
    })),
  };
  const startup = {
    initializeRecovery: guarded('recovery'),
    initializeServices: guarded('services'),
    preparePresentation: guarded('presentation'),
    activateTimers: guarded('timers'),
  };
  const cancellation = new AbortController();
  const recovery = new CoreCaptureRecovery({
    dataDirectory: directory,
    socket: path.join(directory, 'host.sock'),
    docker: {} as never,
    queue,
    startup,
    signal: cancellation.signal,
    onCleanupFailure: state.cleanupWarning,
  });
  return { recovery, queue, startup, cancellation };
}

async function sentinel() {
  const binding = {
    id,
    preparationSha256: String(state.marker.preparationSha256),
    sourceSha256: String(state.marker.sourceSha256),
    pointReservationSha256: String(state.marker.pointReservationSha256),
    controller: { id: 'd'.repeat(64), imageId: `sha256:${'e'.repeat(64)}`, startedAt: 'original', definitionSha256: 'f'.repeat(64) },
  };
  await rememberCoreCapturePublisher(directory, binding, new AbortController().signal);
  const ready = {
    version: 1,
    publisher: 'sentinel.v1',
    state: 'verified',
    ...binding,
    sourceHoldSha256: sha(state.marker),
    receiptSha256: '1'.repeat(64),
    publicationSha256: '2'.repeat(64),
    terminalSha256: '3'.repeat(64),
    publication: { files: { 'point.json': { bytes: 5, sha256: '4'.repeat(64) } } },
    expectation: { pointId: id },
  };
  state.negotiatePublication.mockResolvedValue(true);
  state.publicationStatus.mockResolvedValue(ready);
  state.downloadPublication.mockImplementation(async (_token, directory: string) => {
    await fs.writeFile(path.join(directory, 'point.json'), 'point', { mode: 0o600 });
    return { directory, publication: ready.publication, expectation: ready.expectation, pointReservationSha256: binding.pointReservationSha256 };
  });
  return ready;
}

it('adopts the selected Sentinel point without invoking the controller sealer', async () => {
  await sentinel();
  await fixture().recovery.continue();
  expect(state.downloadPublication).toHaveBeenCalledOnce();
  expect(state.adopt).toHaveBeenCalledOnce();
  expect(state.save).not.toHaveBeenCalled();
  expect(state.events.indexOf('adopt')).toBeLessThan(state.events.indexOf('approve'));
});

it('resumes the same durable transfer after adoption was interrupted', async () => {
  await sentinel();
  state.adopt.mockRejectedValueOnce(new Error('Interrupted promotion'));
  await expect(fixture().recovery.continue()).rejects.toThrow('Interrupted promotion');
  expect(state.capture).toBe(true);
  state.downloadPublication.mockClear();
  await fixture().recovery.continue();
  expect(state.downloadPublication).not.toHaveBeenCalled();
  expect(state.adopt).toHaveBeenCalledTimes(2);
  expect(state.save).not.toHaveBeenCalled();
});

it('keeps the hold when the original interrupted transfer directory was replaced', async () => {
  await sentinel();
  state.adopt.mockRejectedValueOnce(new Error('Interrupted promotion'));
  await expect(fixture().recovery.continue()).rejects.toThrow('Interrupted promotion');
  const parent = path.join(directory, 'backups/time-machine/core-capture', id);
  const record = JSON.parse(await fs.readFile(path.join(parent, 'transfer.json'), 'utf8'));
  const original = path.join(parent, record.directory);
  await fs.rename(original, `${original}-preserved`);
  await fs.mkdir(original, { mode: 0o700 });
  state.downloadPublication.mockClear();
  await expect(fixture().recovery.continue()).rejects.toThrow();
  expect(state.downloadPublication).not.toHaveBeenCalled();
  expect(state.adopt).toHaveBeenCalledOnce();
  expect(state.finish).not.toHaveBeenCalled();
  expect(state.capture).toBe(true);
  expect(await fs.readFile(path.join(`${original}-preserved`, 'point.json'), 'utf8')).toBe('point');
});

it('never falls back to a second publisher when Sentinel support disappears', async () => {
  await sentinel();
  state.negotiatePublication.mockResolvedValue(false);
  await expect(fixture().recovery.continue()).rejects.toThrow();
  expect(state.save).not.toHaveBeenCalled();
  expect(state.adopt).not.toHaveBeenCalled();
  expect(state.capture).toBe(true);
});

it('rejects Sentinel publication when the source publisher record is absent', async () => {
  await sentinel();
  await fs.unlink(path.join(directory, 'backups/time-machine/core-capture', id, 'publisher.json'));
  await expect(fixture().recovery.continue()).rejects.toThrow();
  expect(state.save).not.toHaveBeenCalled();
  expect(state.adopt).not.toHaveBeenCalled();
});

it('saves before reopening services, commits after consumer readiness, and removes only successful staging', async () => {
  const { recovery, startup, queue } = fixture();
  await Promise.all([recovery.continue(), recovery.continue()]);
  expect(state.save).toHaveBeenCalledOnce();
  expect(state.events.filter((name) => name !== 'recheck')).toEqual([
    'save',
    'approve',
    'initialize',
    'recovery',
    'services',
    'presentation',
    'consumers',
    'timers',
    'continuation',
    'commit',
    'settle',
  ]);
  expect(startup.activateTimers).toHaveBeenCalledOnce();
  expect(queue.resumeCoreCaptureConsumers).toHaveBeenCalledOnce();
  expect(state.release).toHaveBeenCalledOnce();
  expect(state.capture).toBe(false);
  expect(await fs.readdir(path.join(directory, 'backups', 'time-machine', 'core-capture', id))).toEqual([]);
});

it('resumes a sealed point without downloading or saving it again', async () => {
  state.point.status = 'sealed';
  await fixture().recovery.continue();
  expect(state.status).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
  expect(state.readDraft).toHaveBeenCalledOnce();
  expect(state.finish).toHaveBeenCalledOnce();
});

it('continues the same sealed point after root readiness failed before initialization', async () => {
  state.point.status = 'sealed';
  state.completion.mockRejectedValueOnce(Error('Broker not ready.'));
  const { recovery, startup, queue } = fixture();
  await expect(recovery.continue()).rejects.toThrow('Broker not ready');
  expect(recovery.status(id, 1)).toEqual({ id, state: 'needs-attention', canContinue: true });
  expect(startup.initializeRecovery).not.toHaveBeenCalled();
  await recovery.retry(id, 1);
  expect(recovery.status(id, 1)).toEqual({ id, state: 'complete', canContinue: false });
  expect(state.completion).toHaveBeenCalledTimes(2);
  expect(state.save).not.toHaveBeenCalled();
  expect(state.adopt).not.toHaveBeenCalled();
  expect(queue.resumeCoreCaptureConsumers).toHaveBeenCalledOnce();
  expect(startup.initializeRecovery).toHaveBeenCalledOnce();
  expect(state.finish).toHaveBeenCalledOnce();
});

it('refuses another operator, another point and a simultaneous second continuation', async () => {
  state.point.status = 'sealed';
  state.completion.mockRejectedValueOnce(Error('Broker not ready.'));
  const { recovery } = fixture();
  await expect(recovery.continue()).rejects.toThrow();
  expect(() => recovery.status(id, 2)).toThrow();
  expect(() => recovery.retry(id, 2)).toThrow();
  expect(() => recovery.retry('22222222-2222-4222-8222-222222222222', 1)).toThrow();
  const resumed = recovery.retry(id, 1);
  expect(() => recovery.retry(id, 1)).toThrow();
  expect(recovery.continue()).toBe(resumed);
  await resumed;
  expect(state.completion).toHaveBeenCalledTimes(2);
  expect(state.finish).toHaveBeenCalledOnce();
});

it('rechecks the original source hold before continuing and cannot adopt a different binding', async () => {
  state.point.status = 'sealed';
  state.completion.mockRejectedValueOnce(Error('Broker not ready.'));
  const { recovery, startup } = fixture();
  await expect(recovery.continue()).rejects.toThrow();
  state.marker.sourceSha256 = '9'.repeat(64);
  state.readDraft.mockClear();
  await expect(recovery.retry(id, 1)).rejects.toThrow('needs recovery');
  expect(state.readDraft).not.toHaveBeenCalled();
  expect(state.completion).toHaveBeenCalledOnce();
  expect(state.save).not.toHaveBeenCalled();
  expect(startup.initializeRecovery).not.toHaveBeenCalled();
  expect(state.capture).toBe(true);
});

it('refuses a sealed point changed back to capturing instead of downloading or publishing again', async () => {
  state.point.status = 'sealed';
  state.completion.mockRejectedValueOnce(Error('Broker not ready.'));
  const { recovery } = fixture();
  await expect(recovery.continue()).rejects.toThrow();
  state.point.status = 'capturing';
  await expect(recovery.retry(id, 1)).rejects.toThrow('needs recovery');
  expect(state.status).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
  expect(state.adopt).not.toHaveBeenCalled();
  expect(state.completion).toHaveBeenCalledOnce();
});

it('never retries after any service initialization could have begun', async () => {
  state.point.status = 'sealed';
  const { recovery, startup } = fixture();
  startup.initializeRecovery.mockRejectedValueOnce(Error('Startup interrupted.'));
  await expect(recovery.continue()).rejects.toThrow('Startup interrupted');
  expect(recovery.status(id, 1).canContinue).toBe(false);
  expect(() => recovery.retry(id, 1)).toThrow();
  expect(startup.initializeRecovery).toHaveBeenCalledOnce();
  expect(state.finish).not.toHaveBeenCalled();
  expect(state.capture).toBe(true);
});

it('keeps shutdown cancellation and failed publication outside the continuation path', async () => {
  state.point.status = 'sealed';
  state.completion.mockRejectedValueOnce(Error('Broker not ready.'));
  const { recovery, cancellation } = fixture();
  await expect(recovery.continue()).rejects.toThrow();
  cancellation.abort();
  expect(recovery.status(id, 1).canContinue).toBe(false);
  expect(() => recovery.retry(id, 1)).toThrow();
  expect(state.completion).toHaveBeenCalledOnce();
  state.point.status = 'capturing';
  state.save.mockRejectedValueOnce(Error('Publication failed.'));
  const failed = fixture().recovery;
  await expect(failed.continue()).rejects.toThrow('Publication failed');
  expect(() => failed.retry(id, 1)).toThrow();
});

it('observes a lost commit reply once and accepts only the matching completed continuation', async () => {
  state.finish.mockImplementation(async () => {
    state.rootState = 'complete';
    throw Error('Reply lost.');
  });
  await fixture().recovery.continue();
  expect(state.finish).toHaveBeenCalledOnce();
  expect(state.completion).toHaveBeenCalledTimes(2);
  expect(state.capture).toBe(false);
});

it('does not repeat an already committed continuation', async () => {
  state.point.status = 'sealed';
  state.rootState = 'complete';
  await fixture().recovery.continue();
  expect(state.writeContinuation).not.toHaveBeenCalled();
  expect(state.finish).not.toHaveBeenCalled();
  expect(state.completion).toHaveBeenCalledTimes(2);
});

it('refuses a reservation swap before draft, download or service initialization', async () => {
  state.point.ownerId = 2;
  const { recovery, startup } = fixture();
  await expect(recovery.continue()).rejects.toThrow('needs recovery');
  expect(state.readDraft).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
  expect(startup.initializeRecovery).not.toHaveBeenCalled();
  expect(state.capture).toBe(true);
});

it('keeps failed publication staging and never asks root to clear it', async () => {
  state.save.mockRejectedValue(Error('Storage unavailable.'));
  const { recovery } = fixture();
  await expect(recovery.continue()).rejects.toThrow('Storage unavailable');
  expect(state.completion).not.toHaveBeenCalled();
  expect(state.capture).toBe(true);
  expect((await fs.readdir(path.join(directory, 'backups', 'time-machine', 'core-capture', id)))[0]).toMatch(/^transfer-/);
  await expect(recovery.continue()).rejects.toThrow('Storage unavailable');
  expect(state.save).toHaveBeenCalledOnce();
});

it('holds on startup failure without starting consumers or submitting a continuation', async () => {
  const { recovery, startup, queue } = fixture();
  startup.initializeServices.mockRejectedValue(Error('Recovery failed.'));
  await expect(recovery.continue()).rejects.toThrow('Recovery failed');
  expect(queue.resumeCoreCaptureConsumers).not.toHaveBeenCalled();
  expect(state.finish).not.toHaveBeenCalled();
  expect(state.capture).toBe(true);
  expect(state.release).toHaveBeenCalledOnce();
});

it('rejects a different continuation returned after a lost reply', async () => {
  state.finish.mockRejectedValue(Error('Reply lost.'));
  state.completion.mockResolvedValueOnce(approval()).mockResolvedValueOnce(approval(true, '9'.repeat(64)));
  await expect(fixture().recovery.continue()).rejects.toThrow('Wrong continuation');
  expect(state.capture).toBe(true);
});

it('cancels before acquiring maintenance or accessing capture storage', async () => {
  const { recovery, cancellation } = fixture();
  cancellation.abort();
  await expect(recovery.continue()).rejects.toThrow();
  expect(state.load).not.toHaveBeenCalled();
  expect(state.release).not.toHaveBeenCalled();
});

const transportError = (code = 'ECONNRESET') => Object.assign(new Error('Host connection interrupted.'), { code });

it('retries an initial status disconnect with the hold intact and no premature startup', async () => {
  vi.useFakeTimers();
  state.status.mockRejectedValueOnce(transportError());
  const { recovery, startup } = fixture();
  const result = recovery.continue();
  await waitForInitialStatus();
  expect(state.status).toHaveBeenCalledOnce();
  expect(state.held).toBe(true);
  expect(state.capture).toBe(true);
  expect(state.release).not.toHaveBeenCalled();
  expect(state.save).not.toHaveBeenCalled();
  expect(startup.initializeRecovery).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(999);
  expect(state.status).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await result;
  expect(state.status).toHaveBeenCalledTimes(2);
  expect(state.save).toHaveBeenCalledOnce();
  expect(startup.initializeRecovery).toHaveBeenCalledOnce();
  expect(state.release).toHaveBeenCalledOnce();
});

it.each(['download', 'publication'] as const)('retries only the initial %s preparation before startup', async (phase) => {
  vi.useFakeTimers();
  const operation = phase === 'download' ? state.prepareDownload : state.completion;
  operation.mockRejectedValueOnce(transportError('ECONNREFUSED'));
  const { recovery, startup } = fixture();
  const result = recovery.continue();
  await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
  expect(state.held).toBe(true);
  expect(state.release).not.toHaveBeenCalled();
  expect(startup.initializeRecovery).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(operation).toHaveBeenCalledTimes(2);
  expect(state.save).toHaveBeenCalledOnce();
  expect(startup.initializeRecovery).toHaveBeenCalledOnce();
});

it.each([undefined, 'EACCES', '403', '409'] as const)('does not retry a permanent verification error with code %s', async (code) => {
  vi.useFakeTimers();
  const error = Object.assign(new Error('Capture response could not be verified.'), code ? { code } : {});
  state.status.mockRejectedValue(error);
  const { recovery, startup } = fixture();
  await expect(recovery.continue()).rejects.toBe(error);
  expect(state.status).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  expect(startup.initializeRecovery).not.toHaveBeenCalled();
  expect(state.capture).toBe(true);
  expect(state.release).toHaveBeenCalledOnce();
});

it('exhausts exactly five transport attempts with 1,2,4,8 second waits and stays sticky-held', async () => {
  vi.useFakeTimers();
  const error = transportError('ENOENT');
  state.status.mockRejectedValue(error);
  const { recovery, startup } = fixture();
  const result = recovery.continue();
  const rejected = expect(result).rejects.toBe(error);
  await waitForInitialStatus();
  expect(state.status).toHaveBeenCalledOnce();
  for (const [index, delay] of [1000, 2000, 4000, 8000].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(state.status).toHaveBeenCalledTimes(index + 1);
    expect(state.held).toBe(true);
    expect(state.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.status).toHaveBeenCalledTimes(index + 2);
  }
  await rejected;
  expect(state.capture).toBe(true);
  expect(state.release).toHaveBeenCalledOnce();
  expect(startup.initializeRecovery).not.toHaveBeenCalled();
  await expect(recovery.continue()).rejects.toBe(error);
  expect(state.status).toHaveBeenCalledTimes(5);
});

it('cancels during a reconnect wait without performing more IO or startup work', async () => {
  vi.useFakeTimers();
  state.status.mockRejectedValue(transportError('ETIMEDOUT'));
  const { recovery, startup, cancellation } = fixture();
  const result = recovery.continue();
  const rejected = expect(result).rejects.toThrow();
  await waitForInitialStatus();
  expect(state.status).toHaveBeenCalledOnce();
  cancellation.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(15000);
  expect(state.status).toHaveBeenCalledOnce();
  expect(state.save).not.toHaveBeenCalled();
  expect(state.completion).not.toHaveBeenCalled();
  expect(startup.initializeRecovery).not.toHaveBeenCalled();
  expect(state.capture).toBe(true);
  expect(state.release).toHaveBeenCalledOnce();
});

it('does not retry transport failures from save or startup callbacks', async () => {
  const error = transportError('EPIPE');
  state.save.mockRejectedValueOnce(error);
  let f = fixture();
  await expect(f.recovery.continue()).rejects.toBe(error);
  expect(state.save).toHaveBeenCalledOnce();
  expect(state.completion).not.toHaveBeenCalled();
  expect(state.capture).toBe(true);
  state.save.mockImplementation(async () => {
    state.point.status = 'sealed';
  });
  f = fixture();
  f.startup.initializeServices.mockRejectedValueOnce(error);
  await expect(f.recovery.continue()).rejects.toBe(error);
  expect(f.startup.initializeServices).toHaveBeenCalledOnce();
  expect(state.finish).not.toHaveBeenCalled();
  expect(state.capture).toBe(true);
});

it('never retries finish or its post-startup reconciliation after a transport failure', async () => {
  const error = transportError();
  state.finish.mockRejectedValueOnce(error);
  state.completion.mockResolvedValueOnce(approval()).mockRejectedValueOnce(error);
  const f = fixture();
  await expect(f.recovery.continue()).rejects.toBe(error);
  expect(state.finish).toHaveBeenCalledOnce();
  expect(state.completion).toHaveBeenCalledTimes(2);
  expect(f.startup.initializeServices).toHaveBeenCalledOnce();
  expect(state.capture).toBe(true);
});

it('retries a transient status disconnect while waiting for the capture worker', async () => {
  vi.useFakeTimers();
  state.status.mockResolvedValueOnce({ state: 'running' }).mockRejectedValueOnce(transportError());
  const f = fixture();
  const result = f.recovery.continue();
  await waitForInitialStatus();
  expect(state.status).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1000);
  expect(state.status).toHaveBeenCalledTimes(2);
  expect(state.held).toBe(true);
  expect(state.release).not.toHaveBeenCalled();
  expect(f.startup.initializeRecovery).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(state.status).toHaveBeenCalledTimes(3);
  expect(state.save).toHaveBeenCalledOnce();
});

it('does not retry reconciliation of an already committed capture after startup', async () => {
  state.point.status = 'sealed';
  state.rootState = 'complete';
  const error = transportError('ECONNREFUSED');
  state.completion.mockResolvedValueOnce(approval(true)).mockRejectedValueOnce(error);
  const f = fixture();
  await expect(f.recovery.continue()).rejects.toBe(error);
  expect(state.completion).toHaveBeenCalledTimes(2);
  expect(state.finish).not.toHaveBeenCalled();
  expect(f.startup.initializeServices).toHaveBeenCalledOnce();
  expect(state.capture).toBe(true);
  await expect(f.recovery.continue()).rejects.toBe(error);
  expect(f.startup.initializeServices).toHaveBeenCalledOnce();
});
