import fs, { type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import path from 'node:path';
import {
  acquireBackupMaintenance,
  backupMaintenanceActive,
  backupMaintenanceLeaseHeld,
  coreCaptureRecoveryRequired,
  holdCoreCaptureRecovery,
  settleCoreCaptureAbortRecovery,
  settleCoreCaptureEmptyAbortRecovery,
} from '@/common/backup-maintenance';
import type { CoreCaptureQueueSetup, QueueFactory } from '../queue/queue.factory';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { createOwnedCoreCaptureMarker, reconcileOwnedCoreCaptureMarker, type OwnedCoreCaptureMarker } from './time-machine-core-owned-marker';
import type { CoreCaptureCompletionDetails } from '../host-updates/host-core-capture-completion-client';
import {
  useVerifiedCoreAbortIntent,
  useVerifiedCoreAbortApproval,
  type VerifiedCoreAbortIntent,
  type VerifiedCoreAbortApproval,
  type VerifiedCoreAbortComplete,
  type CoreCaptureAbortIntentDetails,
  type CoreCaptureAbortDetails,
  type CoreCaptureAbortPreparation,
  validateCoreCaptureAbortPreparation,
} from '../host-updates/host-core-capture-abort-client';
import {
  useVerifiedCoreEmptyAbortApproval,
  type VerifiedCoreEmptyAbortApproval,
  type VerifiedCoreEmptyAbortComplete,
  type CoreCaptureEmptyAbortDetails,
} from '../host-updates/host-core-capture-empty-abort-client';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const names = ['app-events-queue', 'repo-queue', 'system-events-queue'];
const fail = () => new Error('Core capture source hold requires review.');
const unwoundSourceFailures = new WeakSet<object>();
export const coreCaptureSourceFailureWasUnwound = (error: unknown) => typeof error === 'object' && error !== null && unwoundSourceFailures.has(error);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  record(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const validString = (v: unknown, regex: RegExp) => typeof v === 'string' && regex.test(v);
export type CoreCapturePreparation = {
  id: string;
  operatorAuthorizationId: string;
  preparationSha256: string;
  sourceSha256: string;
  pointReservationSha256?: string;
  controller: { id: string; imageId: string; startedAt: string; definitionSha256: string };
};
type Drain = { pauseId: string; generation: number; queues: { name: string; messages: number; consumers: number }[] };
type Marker = CoreCapturePreparation & {
  schema: 'orbis.core-capture-source-hold.v1' | 'orbis.core-capture-source-hold.v2';
  drainReservationId: string;
  queueDrain: Drain;
};
type SourceHold = { marker: Marker; sourceHoldSha256: string; recheck: () => Promise<void>; handoff: <T>(request: () => Promise<T>) => Promise<T> };
type AbortTerminal = { id: string; preparationSha256: string; decisionSha256: string; terminalSha256: string; sourceHoldSha256: string };
type SourceControl = {
  dataDir: string;
  paused: Awaited<ReturnType<QueueFactory['pauseForBackup']>>;
  release: () => void;
  bytes: Buffer;
  seal: Awaited<ReturnType<FileHandle['stat']>>;
  sealed: boolean;
  handedOff: boolean;
  settled: boolean;
  handoff?: Promise<unknown>;
  terminal?: Promise<AbortTerminal>;
  terminalBytes?: Buffer;
  intent?: CoreCaptureAbortIntentDetails;
  continuation?: Promise<{ id: string; continuationSha256: string }>;
  approval?: CoreCaptureAbortDetails;
  queueProof?: Awaited<ReturnType<QueueFactory['resumeCoreCapturePause']>>;
};
const sourceControls = new WeakMap<SourceHold, SourceControl>();
declare const sourceAttemptBrand: unique symbol;
export type ReservedCoreCaptureSourceAttempt = { readonly [sourceAttemptBrand]: true };
type SourceQueue = Pick<QueueFactory, 'pauseForBackup' | 'resumeCoreCapturePause' | 'recheckCoreCapturePause' | 'verifyCoreCaptureSetupUnwind'> &
  Partial<Pick<QueueFactory, 'createCoreCaptureQueueSetup' | 'verifyCoreCaptureSetupRefusal'>>;
type RetainedAttempt = {
  dataDir: string;
  preparation: CoreCapturePreparation;
  rootPreparation: CoreCaptureAbortPreparation;
  queue: SourceQueue;
  sealed: boolean;
  finished: boolean;
  markerStarted: boolean;
  settled: boolean;
  execution?: Promise<SourceHold>;
  source?: SourceHold;
  paused?: Awaited<ReturnType<QueueFactory['pauseForBackup']>>;
  release?: () => void;
  drain?: Drain;
  ownedMarker?: OwnedCoreCaptureMarker;
  repair?: Promise<SourceHold>;
  approval?: CoreCaptureEmptyAbortDetails;
  continuation?: Promise<{ id: string; continuationSha256: string }>;
  queueProof?: Awaited<ReturnType<QueueFactory['resumeCoreCapturePause']>>;
  setupUnwind?: object;
  setupScope?: CoreCaptureQueueSetup;
  queueRefusal?: Omit<NonNullable<Awaited<ReturnType<QueueFactory['verifyCoreCaptureSetupRefusal']>>>, 'recheck'>;
};
const retainedAttempts = new WeakMap<ReservedCoreCaptureSourceAttempt, RetainedAttempt>();
const issuedSourceAttempts = new Map<string, WeakRef<ReservedCoreCaptureSourceAttempt>>();
function validate(v: unknown): asserts v is Marker {
  const bound = record(v) && v.schema === 'orbis.core-capture-source-hold.v2';
  if (
    !exact(v, [
      'schema',
      'id',
      'operatorAuthorizationId',
      'drainReservationId',
      'preparationSha256',
      'sourceSha256',
      'controller',
      'queueDrain',
      ...(bound ? ['pointReservationSha256'] : []),
    ]) ||
    (!bound && v.schema !== 'orbis.core-capture-source-hold.v1') ||
    (bound && !validString(v.pointReservationSha256, hash)) ||
    !validString(v.id, uuid) ||
    !validString(v.operatorAuthorizationId, uuid) ||
    !validString(v.drainReservationId, uuid) ||
    !validString(v.preparationSha256, hash) ||
    !validString(v.sourceSha256, hash) ||
    !exact(v.controller, ['id', 'imageId', 'startedAt', 'definitionSha256']) ||
    !validString(v.controller.id, hash) ||
    !validString(v.controller.imageId, /^sha256:[0-9a-f]{64}$/) ||
    !validString(v.controller.definitionSha256, hash) ||
    typeof v.controller.startedAt !== 'string' ||
    !/^[\x20-\x7e]{1,128}$/.test(v.controller.startedAt) ||
    !exact(v.queueDrain, ['pauseId', 'generation', 'queues']) ||
    v.queueDrain.pauseId !== v.drainReservationId ||
    !Number.isSafeInteger(v.queueDrain.generation) ||
    (v.queueDrain.generation as number) < 1 ||
    !Array.isArray(v.queueDrain.queues) ||
    v.queueDrain.queues.length !== 3 ||
    v.queueDrain.queues.some((q: unknown) => !exact(q, ['name', 'messages', 'consumers']) || q.messages !== 0 || q.consumers !== 0) ||
    v.queueDrain.queues
      .map((q: { name: string }) => q.name)
      .sort()
      .join(',') !== names.join(',')
  )
    throw fail();
}
const identity = (a: Awaited<ReturnType<FileHandle['stat']>>, b: Awaited<ReturnType<FileHandle['stat']>>) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.uid === b.uid &&
  a.mode === b.mode &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
const directoryIdentity = (a: Awaited<ReturnType<FileHandle['stat']>>, b: Awaited<ReturnType<FileHandle['stat']>>) =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode;
const own = (uid: number) => typeof process.getuid === 'function' && uid === process.getuid();

// Directory descriptors anchor all child operations; unsupported platforms fail closed.
async function directory(dataDir: string, create: boolean) {
  if (!path.isAbsolute(dataDir) || path.resolve(dataDir) !== dataDir || process.platform !== 'linux') throw fail();
  const refs = '/proc/self/fd';
  const handles: FileHandle[] = [];
  const entries: { at: string; handle: FileHandle; before: Awaited<ReturnType<FileHandle['stat']>> }[] = [];
  try {
    if ((await fs.realpath(dataDir)) !== dataDir) throw fail();
    let at = dataDir;
    for (const [index, part] of ['', 'backups', 'time-machine', 'core-capture'].entries()) {
      if (part) {
        const previous = handles.at(-1);
        if (!previous) throw fail();
        at = `${refs}/${previous.fd}/${part}`;
      }
      if (create && index === 3)
        await fs.mkdir(at, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'EEXIST') throw e;
        });
      const before = await fs.lstat(at);
      if (
        !before.isDirectory() ||
        before.isSymbolicLink() ||
        !own(before.uid) ||
        (before.mode & 0o022) !== 0 ||
        (index === 3 && (before.mode & 0o7777) !== 0o700)
      )
        throw fail();
      const handle = await fs.open(at, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(handle);
      if (!identity(before, await handle.stat())) throw fail();
      const reference = await fs.stat(`${refs}/${handle.fd}`).catch(() => {
        throw fail();
      });
      if (!identity(before, reference)) throw fail();
      entries.push({ at, handle, before });
    }
    const recheck = async () => {
      for (const entry of entries)
        if (!directoryIdentity(entry.before, await entry.handle.stat()) || !directoryIdentity(entry.before, await fs.lstat(entry.at))) throw fail();
    };
    await recheck();
    const parent = handles.at(-1);
    if (!parent) throw fail();
    return {
      parent,
      binding: await Promise.all(handles.map((handle) => handle.stat({ bigint: true }))),
      at: `${refs}/${parent.fd}/source-hold.json`,
      recheck,
      close: async () => {
        await Promise.all(handles.map((h) => h.close()));
      },
    };
  } catch (error) {
    await Promise.all(handles.map((h) => h.close()));
    throw error;
  }
}
async function readMarker(at: string) {
  const h = await fs.open(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await h.stat();
    if (!before.isFile() || !own(before.uid) || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600 || before.size < 1 || before.size > 8192)
      throw fail();
    const bounded = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bounded.length) {
      const { bytesRead } = await h.read(bounded, count, bounded.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count !== before.size) throw fail();
    const bytes = bounded.subarray(0, count);
    if (!identity(before, await h.stat()) || !identity(before, await fs.lstat(at))) throw fail();
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    validate(value);
    if (!bytes.equals(Buffer.from(canonicalPublicationJson(value)))) throw fail();
    return { value, bytes, seal: before };
  } finally {
    await h.close();
  }
}
export async function inspectCoreCaptureSourceHold(dataDir: string): Promise<'absent' | 'held' | 'invalid'> {
  try {
    if (!path.isAbsolute(dataDir) || path.resolve(dataDir) !== dataDir) throw fail();
    let ancestor = path.parse(dataDir).root;
    for (const part of dataDir.slice(ancestor.length).split(path.sep).filter(Boolean)) {
      ancestor = path.join(ancestor, part);
      let stat: Awaited<ReturnType<FileHandle['stat']>>;
      try {
        stat = await fs.lstat(ancestor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
    }
    if ((await fs.realpath(dataDir)) !== dataDir) throw fail();
  } catch {
    holdCoreCaptureRecovery();
    return 'invalid';
  }
  try {
    let current = dataDir;
    for (const [index, part] of ['', 'backups', 'time-machine', 'core-capture', 'source-hold.json'].entries()) {
      if (part) current = path.join(current, part);
      let stat: Awaited<ReturnType<FileHandle['stat']>>;
      try {
        stat = await fs.lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
        throw error;
      }
      if (
        stat.isSymbolicLink() ||
        !own(stat.uid) ||
        (index < 4 && (stat.mode & 0o022) !== 0) ||
        (index < 4 && !stat.isDirectory()) ||
        (index === 3 && (stat.mode & 0o7777) !== 0o700) ||
        (index === 4 && (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600))
      )
        throw fail();
    }
  } catch {
    holdCoreCaptureRecovery();
    return 'invalid';
  }
  if (process.platform !== 'linux') {
    holdCoreCaptureRecovery();
    return 'invalid';
  }
  let dir: Awaited<ReturnType<typeof directory>> | undefined;
  try {
    dir = await directory(dataDir, false);
    await readMarker(dir.at);
    await dir.recheck();
    holdCoreCaptureRecovery();
    return 'held';
  } catch {
    holdCoreCaptureRecovery();
    return 'invalid';
  } finally {
    await dir?.close();
  }
}
export function prepareCoreCaptureSourceHold(
  dataDir: string,
  preparation: CoreCapturePreparation,
  queue: Pick<QueueFactory, 'pauseForBackup'>,
  signal: AbortSignal,
  beforeMarker?: () => Promise<void>,
) {
  return prepareSourceHold(dataDir, preparation, queue, signal, beforeMarker);
}
function createSourceHold(
  dataDir: string,
  marker: Marker,
  bytes: Buffer,
  markerSeal: Awaited<ReturnType<FileHandle['stat']>>,
  heldQueues: Awaited<ReturnType<QueueFactory['pauseForBackup']>>,
  release: () => void,
  signal: AbortSignal,
  sealed: boolean,
): SourceHold {
  const verify = async () => {
    signal.throwIfAborted();
    const d = await directory(dataDir, false);
    try {
      const currentMarker = await readMarker(d.at);
      if (!markerSeal || !identity(markerSeal, currentMarker.seal) || !currentMarker.bytes.equals(bytes)) throw fail();
      await d.recheck();
    } finally {
      await d.close();
    }
    const current = await heldQueues.verify();
    if (
      current.pauseId !== marker.queueDrain.pauseId ||
      current.generation !== marker.queueDrain.generation ||
      canonicalPublicationJson(current.queues) !== canonicalPublicationJson(marker.queueDrain.queues)
    )
      throw fail();
  };
  const control: SourceControl = {
    dataDir,
    paused: heldQueues,
    release,
    bytes,
    seal: markerSeal,
    sealed,
    handedOff: false,
    settled: false,
  };
  const source: SourceHold = {
    marker,
    sourceHoldSha256: createHash('sha256').update(bytes).digest('hex'),
    recheck: verify,
    handoff: <T>(request: () => Promise<T>): Promise<T> => {
      if (control.sealed || control.handedOff) return Promise.reject(fail());
      control.handedOff = true;
      const pending = (async () => {
        await verify();
        if (control.sealed) throw fail();
        return request();
      })();
      control.handoff = pending;
      return pending;
    },
  };
  sourceControls.set(source, control);
  return source;
}

async function prepareSourceHold(
  dataDir: string,
  preparation: CoreCapturePreparation,
  queue: Pick<QueueFactory, 'pauseForBackup'>,
  signal: AbortSignal,
  beforeMarker?: () => Promise<void>,
  retained?: RetainedAttempt,
) {
  if (backupMaintenanceActive()) throw fail();
  let release: (() => void) | undefined;
  let paused: Awaited<ReturnType<QueueFactory['pauseForBackup']>> | undefined;
  let markerStarted = false;
  let markerSeal: Awaited<ReturnType<FileHandle['stat']>> | undefined;
  try {
    if (coreCaptureRecoveryRequired()) throw fail();
    paused = await (retained?.setupScope ? retained.setupScope.pauseForBackup(signal) : queue.pauseForBackup(signal));
    if (retained) retained.paused = paused;
    const heldQueues = paused;
    release = await acquireBackupMaintenance(signal);
    if (retained) retained.release = release;
    const check = await paused.verify();
    const drain = { pauseId: check.pauseId, generation: check.generation, queues: check.queues };
    if (check.pauseId !== paused.initial.pauseId || check.generation !== paused.initial.generation) throw fail();
    if (retained) retained.drain = structuredClone(drain);
    const marker: Marker = {
      ...preparation,
      schema: Object.hasOwn(preparation, 'pointReservationSha256') ? 'orbis.core-capture-source-hold.v2' : 'orbis.core-capture-source-hold.v1',
      drainReservationId: check.pauseId,
      queueDrain: drain,
    };
    validate(marker);
    await beforeMarker?.();
    if (retained?.sealed) throw fail();
    signal.throwIfAborted();
    const finalCheck = await paused.verify();
    if (
      coreCaptureRecoveryRequired() ||
      finalCheck.pauseId !== drain.pauseId ||
      finalCheck.generation !== drain.generation ||
      canonicalPublicationJson(finalCheck.queues) !== canonicalPublicationJson(drain.queues)
    )
      throw fail();
    const bytes = Buffer.from(canonicalPublicationJson(marker));
    signal.throwIfAborted();
    const dir = await directory(dataDir, true);
    try {
      await dir.recheck();
      markerStarted = true;
      if (retained) retained.markerStarted = true;
      holdCoreCaptureRecovery();
      await createOwnedCoreCaptureMarker(dir, bytes, (token) => {
        if (retained) retained.ownedMarker = token;
      });
      const written = await readMarker(dir.at);
      if (!written.bytes.equals(bytes)) throw fail();
      markerSeal = written.seal;
      await dir.recheck();
    } finally {
      await dir.close();
    }
    if (!markerSeal || !release) throw fail();
    return createSourceHold(dataDir, marker, bytes, markerSeal, heldQueues, release, signal, retained?.sealed ?? false);
  } catch (error) {
    if (retained?.release) {
      holdCoreCaptureRecovery();
      throw error;
    }
    if (retained && !markerStarted && !release) {
      paused?.release();
      if (paused) retained.setupUnwind = paused;
      else if (error && typeof error === 'object') retained.setupUnwind = error;
      throw error;
    }
    if (!markerStarted) {
      try {
        paused?.release();
      } finally {
        release?.();
      }
      const unwound = typeof error === 'object' && error !== null ? error : new Error('Capture setup stopped.', { cause: error });
      unwoundSourceFailures.add(unwound);
      throw unwound;
    }
    throw error;
  }
}

export function createReservedCoreCaptureSourceAttempt(
  dataDir: string,
  preparation: CoreCaptureAbortPreparation,
  operatorAuthorizationId: string,
  queue: SourceQueue,
) {
  const approved = validateCoreCaptureAbortPreparation(preparation);
  if (!uuid.test(operatorAuthorizationId) || !path.isAbsolute(dataDir) || path.resolve(dataDir) !== dataDir) throw fail();
  const identity = createHash('sha256')
    .update(canonicalPublicationJson({ dataDir, id: approved.id }))
    .digest('hex');
  if (issuedSourceAttempts.has(identity)) {
    const original = issuedSourceAttempts.get(identity)?.deref();
    const state = original && retainedAttempts.get(original);
    if (
      !original ||
      !state ||
      state.queue !== queue ||
      state.preparation.operatorAuthorizationId !== operatorAuthorizationId ||
      canonicalPublicationJson(state.rootPreparation) !== canonicalPublicationJson(approved)
    )
      throw fail();
    return original;
  }
  const token = Object.freeze({}) as ReservedCoreCaptureSourceAttempt;
  retainedAttempts.set(token, {
    dataDir,
    rootPreparation: approved,
    preparation: {
      id: approved.id,
      preparationSha256: approved.preparationSha256,
      sourceSha256: approved.sourceSha256,
      pointReservationSha256: approved.pointReservationSha256,
      controller: approved.controller,
      operatorAuthorizationId,
    },
    queue,
    setupScope:
      typeof queue.createCoreCaptureQueueSetup === 'function' && typeof queue.verifyCoreCaptureSetupRefusal === 'function'
        ? queue.createCoreCaptureQueueSetup()
        : undefined,
    sealed: false,
    finished: false,
    markerStarted: false,
    settled: false,
  });
  issuedSourceAttempts.set(identity, new WeakRef(token));
  return token;
}

export function startReservedCoreCaptureSourceAttempt(
  attempt: ReservedCoreCaptureSourceAttempt,
  signal: AbortSignal,
  beforeMarker?: () => Promise<void>,
) {
  const state = retainedAttempts.get(attempt);
  if (!state || (state.sealed && !state.execution)) return Promise.reject(fail());
  state.execution ??= Promise.resolve()
    .then(() => {
      if (state.sealed) throw fail();
      return prepareSourceHold(state.dataDir, state.preparation, state.queue, signal, beforeMarker, state);
    })
    .then((source) => {
      state.source = source;
      return source;
    })
    .finally(() => {
      state.finished = true;
    });
  return state.execution;
}

function stoppedAttempt(attempt: ReservedCoreCaptureSourceAttempt) {
  const state = retainedAttempts.get(attempt);
  if (
    !state ||
    !state.sealed ||
    !state.finished ||
    state.markerStarted ||
    state.source ||
    state.settled ||
    !state.paused ||
    !state.drain ||
    !state.release ||
    !backupMaintenanceLeaseHeld() ||
    !coreCaptureRecoveryRequired()
  )
    throw fail();
  return { state, paused: state.paused, drain: state.drain, release: state.release };
}

export async function stopReservedCoreCaptureSourceAttempt(attempt: ReservedCoreCaptureSourceAttempt, signal = AbortSignal.timeout(30_000)) {
  const state = retainedAttempts.get(attempt);
  if (!state || state.settled) throw fail();
  state.sealed = true;
  if (!state.execution && !state.paused && !state.release && !state.drain && !state.markerStarted && !state.ownedMarker && !state.source) {
    return Object.freeze({
      kind: 'unused' as const,
      dataDirectory: state.dataDir,
      preparation: state.rootPreparation,
      operatorAuthorizationId: state.preparation.operatorAuthorizationId,
    });
  }
  if (state.source) {
    const sourceControl = sourceControls.get(state.source);
    if (!sourceControl) throw fail();
    sourceControl.sealed = true;
  }
  if (state.execution) await Promise.allSettled([state.execution]);
  if (
    state.finished &&
    state.setupScope &&
    state.queue.verifyCoreCaptureSetupRefusal &&
    !state.paused &&
    !state.release &&
    !state.drain &&
    !state.markerStarted &&
    !state.ownedMarker &&
    !state.source
  ) {
    const scope = state.setupScope;
    const proof = await state.queue.verifyCoreCaptureSetupRefusal(scope, signal);
    if (proof) {
      await proof.recheck();
      signal.throwIfAborted();
      if (
        !state.sealed ||
        !state.finished ||
        state.settled ||
        state.setupScope !== scope ||
        state.paused ||
        state.release ||
        state.drain ||
        state.markerStarted ||
        state.ownedMarker ||
        state.source
      )
        throw fail();
      const refusal = { setupId: proof.setupId, outcome: proof.outcome, generation: proof.generation, queues: proof.queues };
      if (state.queueRefusal && canonicalPublicationJson(state.queueRefusal) !== canonicalPublicationJson(refusal)) throw fail();
      return Object.freeze({
        kind: 'setup-refused' as const,
        dataDirectory: state.dataDir,
        preparation: state.rootPreparation,
        operatorAuthorizationId: state.preparation.operatorAuthorizationId,
        queueRefusal: Object.freeze({ ...refusal, queues: Object.freeze(refusal.queues.map((row) => Object.freeze({ ...row }))) }),
      });
    }
  }
  if (state.finished && state.paused && state.release && !state.drain && !state.markerStarted && !state.ownedMarker && !state.source) {
    const paused = state.paused;
    const release = state.release;
    // Recover only the original still-held pause; do not acquire or resume any resource.
    const check = await state.queue.recheckCoreCapturePause(paused, signal);
    signal.throwIfAborted();
    if (
      !state.sealed ||
      !state.finished ||
      state.settled ||
      state.paused !== paused ||
      state.release !== release ||
      state.markerStarted ||
      state.ownedMarker ||
      state.source ||
      !backupMaintenanceLeaseHeld() ||
      !coreCaptureRecoveryRequired() ||
      check.pauseId !== paused.initial.pauseId ||
      check.generation !== paused.initial.generation ||
      canonicalPublicationJson(check.queues) !== canonicalPublicationJson(paused.initial.queues)
    )
      throw fail();
    const recovered = { pauseId: check.pauseId, generation: check.generation, queues: check.queues };
    if (state.drain && canonicalPublicationJson(state.drain) !== canonicalPublicationJson(recovered)) throw fail();
    state.drain ??= structuredClone(recovered);
  }
  if (state.finished && state.setupUnwind && !state.release && !state.markerStarted && !state.ownedMarker && !state.source && !state.drain) {
    const reference = state.setupUnwind;
    const proof = await state.queue.verifyCoreCaptureSetupUnwind(reference, signal);
    await proof.recheck();
    signal.throwIfAborted();
    if (
      !state.sealed ||
      !state.finished ||
      state.settled ||
      state.setupUnwind !== reference ||
      state.release ||
      state.markerStarted ||
      state.ownedMarker ||
      state.source ||
      state.drain
    )
      throw fail();
    return Object.freeze({
      kind: 'setup-unwound' as const,
      dataDirectory: state.dataDir,
      preparation: state.rootPreparation,
      operatorAuthorizationId: state.preparation.operatorAuthorizationId,
      queueUnwind: Object.freeze({
        pauseId: proof.pauseId,
        generation: proof.generation,
        queues: Object.freeze(proof.queues.map((row) => Object.freeze({ ...row }))),
      }),
    });
  }
  if (state.source) {
    const control = sourceControls.get(state.source);
    if (!control) throw fail();
    control.sealed = true;
    return { kind: 'complete' as const, source: state.source };
  }
  if (
    state.finished &&
    state.markerStarted &&
    state.ownedMarker &&
    state.paused &&
    state.drain &&
    state.release &&
    backupMaintenanceLeaseHeld() &&
    coreCaptureRecoveryRequired()
  ) {
    return Object.freeze({ kind: 'interrupted' as const, preparation: state.rootPreparation });
  }
  const stopped = stoppedAttempt(attempt);
  return Object.freeze({
    kind: 'absent' as const,
    dataDirectory: state.dataDir,
    preparation: state.rootPreparation,
    operatorAuthorizationId: state.preparation.operatorAuthorizationId,
    drainReservationId: stopped.drain.pauseId,
    queueGeneration: stopped.drain.generation,
    queues: Object.freeze(stopped.drain.queues.map((row) => Object.freeze({ ...row }))),
  });
}

export async function selectReservedCoreCaptureSetupRefusal(
  attempt: ReservedCoreCaptureSourceAttempt,
  expected: Extract<Awaited<ReturnType<typeof stopReservedCoreCaptureSourceAttempt>>, { kind: 'setup-refused' }>,
  signal: AbortSignal,
) {
  const current = await stopReservedCoreCaptureSourceAttempt(attempt, signal);
  signal.throwIfAborted();
  const state = retainedAttempts.get(attempt);
  if (!state || current.kind !== 'setup-refused' || canonicalPublicationJson(current) !== canonicalPublicationJson(expected)) throw fail();
  state.queueRefusal ??= structuredClone(current.queueRefusal);
}

export async function reconcileReservedCoreCaptureSourceMarker(
  attempt: ReservedCoreCaptureSourceAttempt,
  token: VerifiedCoreAbortIntent,
  signal: AbortSignal,
) {
  const stopped = await stopReservedCoreCaptureSourceAttempt(attempt);
  const state = retainedAttempts.get(attempt);
  if (stopped.kind !== 'interrupted' || !state || !state.ownedMarker || !state.paused || !state.drain || !state.release) throw fail();
  const owned = state.ownedMarker;
  const paused = state.paused;
  const drain = state.drain;
  const release = state.release;
  return useVerifiedCoreAbortIntent(token, async (details) => {
    if (
      ['id', 'preparationSha256', 'sourceSha256', 'pointReservationSha256', 'controller'].some(
        (key) => canonicalPublicationJson(Reflect.get(state.rootPreparation, key)) !== canonicalPublicationJson(Reflect.get(details, key)),
      )
    )
      throw fail();
    state.repair ??= (async () => {
      const verify = async () => {
        signal.throwIfAborted();
        if (!state.sealed || !state.finished || state.settled || state.source || !backupMaintenanceLeaseHeld() || !coreCaptureRecoveryRequired())
          throw fail();
        const check = await state.queue.recheckCoreCapturePause(paused, signal);
        if (
          check.pauseId !== drain.pauseId ||
          check.generation !== drain.generation ||
          canonicalPublicationJson(check.queues) !== canonicalPublicationJson(drain.queues)
        )
          throw fail();
      };
      await verify();
      const dir = await directory(state.dataDir, false);
      try {
        const repaired = await reconcileOwnedCoreCaptureMarker(dir, owned, signal);
        const written = await readMarker(dir.at);
        if (!written.bytes.equals(repaired.bytes) || !sameBigSeal(repaired.seal, await fs.lstat(dir.at, { bigint: true }))) throw fail();
        await verify();
        await dir.recheck();
        const source = createSourceHold(state.dataDir, written.value, written.bytes, written.seal, paused, release, signal, true);
        state.source = source;
        return source;
      } finally {
        await dir.close();
      }
    })();
    return state.repair;
  });
}

function sameEmptyBinding(state: RetainedAttempt, details: CoreCaptureEmptyAbortDetails) {
  return (
    details.version === 2 &&
    details.sourceMarker === 'absent' &&
    ['id', 'preparationSha256', 'sourceSha256', 'pointReservationSha256', 'controller'].every(
      (key) => canonicalPublicationJson(Reflect.get(state.rootPreparation, key)) === canonicalPublicationJson(Reflect.get(details, key)),
    )
  );
}
export function resumeReservedCoreCaptureSourceAttempt(
  attempt: ReservedCoreCaptureSourceAttempt,
  token: VerifiedCoreEmptyAbortApproval,
  writeReady: (
    details: CoreCaptureEmptyAbortDetails,
    proof: Awaited<ReturnType<QueueFactory['resumeCoreCapturePause']>>,
  ) => Promise<{ id: string; continuationSha256: string }>,
  signal: AbortSignal,
) {
  return useVerifiedCoreEmptyAbortApproval(token, async (details) => {
    const { state, paused, drain } = stoppedAttempt(attempt);
    if (!sameEmptyBinding(state, details) || details.state !== 'verified-abort-awaiting-continuation') throw fail();
    if (state.approval && canonicalPublicationJson(state.approval) !== canonicalPublicationJson(details)) throw fail();
    state.approval = details;
    state.continuation ??= (async () => {
      const proof = await state.queue.resumeCoreCapturePause(paused, signal);
      state.queueProof = proof;
      if (proof.pauseId !== drain.pauseId || proof.queueGeneration !== drain.generation) throw fail();
      const ready = await writeReady(details, proof);
      if (ready.id !== state.preparation.id || !hash.test(ready.continuationSha256)) throw fail();
      return ready;
    })();
    return state.continuation;
  });
}
export async function settleReservedCoreCaptureSourceAttempt(
  attempt: ReservedCoreCaptureSourceAttempt,
  token: VerifiedCoreEmptyAbortComplete,
  verifyFiles: (details: CoreCaptureEmptyAbortDetails) => Promise<void>,
  signal: AbortSignal,
) {
  const { state, release } = stoppedAttempt(attempt);
  const approval = state.approval;
  const proof = state.queueProof;
  if (!approval || !proof || !state.continuation) throw fail();
  const ready = await state.continuation;
  await settleCoreCaptureEmptyAbortRecovery(token, async (details) => {
    stoppedAttempt(attempt);
    signal.throwIfAborted();
    if (
      !sameEmptyBinding(state, details) ||
      details.state !== 'complete' ||
      details.continuationSha256 !== ready.continuationSha256 ||
      ['decisionSha256', 'terminalSha256', 'approvalSha256'].some((key) => Reflect.get(details, key) !== Reflect.get(approval, key))
    )
      throw fail();
    await verifyFiles(details);
    await proof.recheck();
    signal.throwIfAborted();
  });
  state.settled = true;
  release();
}

export async function readCoreCaptureSourceHold(dataDir: string): Promise<Readonly<Marker>> {
  const dir = await directory(dataDir, false);
  try {
    const marker = await readMarker(dir.at);
    await dir.recheck();
    return Object.freeze({
      ...marker.value,
      controller: Object.freeze({ ...marker.value.controller }),
      queueDrain: Object.freeze({
        ...marker.value.queueDrain,
        queues: Object.freeze(marker.value.queueDrain.queues.map((q) => Object.freeze({ ...q }))),
      }),
    }) as Readonly<Marker>;
  } finally {
    await dir.close();
  }
}

const bigSealFields = ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const;
const publicSealFields = ['device', 'inode', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const;
const sameBigSeal = (first: BigIntStats, second: BigIntStats) => bigSealFields.every((key) => first[key] === second[key]);
async function abortSource(control: SourceControl, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!control.sealed || control.settled || !backupMaintenanceLeaseHeld() || !coreCaptureRecoveryRequired()) throw fail();
  const dir = await directory(control.dataDir, false);
  try {
    const original = await readMarker(dir.at);
    if (!identity(control.seal, original.seal) || !control.bytes.equals(original.bytes)) throw fail();
    const handle = await fs.open(dir.at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let seal: Record<string, string>;
    try {
      const stat = await handle.stat({ bigint: true });
      if (!sameBigSeal(stat, await handle.stat({ bigint: true })) || !sameBigSeal(stat, await fs.lstat(dir.at, { bigint: true }))) throw fail();
      seal = Object.fromEntries(bigSealFields.map((key, index) => [publicSealFields[index], String(stat[key])]));
    } finally {
      await handle.close();
    }
    const after = await readMarker(dir.at);
    if (!identity(control.seal, after.seal) || !control.bytes.equals(after.bytes)) throw fail();
    await dir.recheck();
    signal.throwIfAborted();
    return { marker: original.value, sourceHoldIdentity: seal };
  } finally {
    await dir.close();
  }
}

async function boundSourceRecord(
  dataDir: string,
  id: string,
  name: 'abort-terminal.json' | 'abort-continuation-ready.json',
  bytes: Buffer,
  verify: () => Promise<unknown>,
  signal: AbortSignal,
  create = true,
) {
  if (!uuid.test(id) || bytes.length < 1 || bytes.length > 8192) throw fail();
  const dir = await directory(dataDir, false);
  let child: FileHandle | undefined;
  try {
    await verify();
    const childPath = `/proc/self/fd/${dir.parent.fd}/${id}`;
    if (create)
      await fs.mkdir(childPath, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    const before = await fs.lstat(childPath);
    if (!before.isDirectory() || before.isSymbolicLink() || !own(before.uid) || (before.mode & 0o7777) !== 0o700) throw fail();
    child = await fs.open(childPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!identity(before, await child.stat())) throw fail();
    const at = `/proc/self/fd/${child.fd}/${name}`;
    if (create) {
      signal.throwIfAborted();
      try {
        const output = await fs.open(at, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          await output.writeFile(bytes);
          await output.sync();
        } finally {
          await output.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const read = async () => {
      const handle = await fs.open(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || !own(Number(stat.uid)) || stat.nlink !== 1n || (stat.mode & 0o7777n) !== 0o600n || stat.size !== BigInt(bytes.length))
          throw fail();
        const content = Buffer.alloc(bytes.length + 1);
        let count = 0;
        while (count < content.length) {
          const result = await handle.read(content, count, content.length - count, null);
          if (!result.bytesRead) break;
          count += result.bytesRead;
        }
        if (
          count !== bytes.length ||
          !content.subarray(0, count).equals(bytes) ||
          !sameBigSeal(stat, await handle.stat({ bigint: true })) ||
          !sameBigSeal(stat, await fs.lstat(at, { bigint: true }))
        )
          throw fail();
        return stat;
      } finally {
        await handle.close();
      }
    };
    const written = await read();
    if (create) {
      await child.sync();
      await dir.parent.sync();
    }
    await verify();
    await dir.recheck();
    if (
      !directoryIdentity(before, await child.stat()) ||
      !directoryIdentity(before, await fs.lstat(childPath)) ||
      !sameBigSeal(written, await read())
    )
      throw fail();
    signal.throwIfAborted();
    return createHash('sha256').update(bytes).digest('hex');
  } finally {
    await child?.close();
    await dir.close();
  }
}
export const openCoreCaptureSourceDirectory = directory;
export const persistBoundCoreCaptureSourceRecord = boundSourceRecord;

export function sealCoreCaptureSourceForAbort(source: SourceHold, token: VerifiedCoreAbortIntent, signal: AbortSignal): Promise<AbortTerminal> {
  const control = sourceControls.get(source);
  if (!control || control.settled) return Promise.reject(fail());
  // Seal before the first await so a pending verification cannot submit a later handoff.
  control.sealed = true;
  return useVerifiedCoreAbortIntent(token, async (details) => {
    if (control.intent && canonicalPublicationJson(control.intent) !== canonicalPublicationJson(details)) throw fail();
    control.intent = details;
    const marker = JSON.parse(control.bytes.toString('utf8')) as Marker;
    if (
      marker.schema !== 'orbis.core-capture-source-hold.v2' ||
      ['id', 'preparationSha256', 'sourceSha256', 'pointReservationSha256'].some((key) => Reflect.get(marker, key) !== Reflect.get(details, key)) ||
      canonicalPublicationJson(marker.controller) !== canonicalPublicationJson(details.controller)
    )
      throw fail();
    control.terminal ??= (async () => {
      if (control.handoff) await Promise.allSettled([control.handoff]);
      const current = await abortSource(control, signal);
      const sourceHoldSha256 = createHash('sha256').update(control.bytes).digest('hex');
      const value = {
        schema: 'orbis.core-capture-source-abort-terminal.v1',
        id: marker.id,
        preparationSha256: marker.preparationSha256,
        decisionSha256: details.decisionSha256,
        sourceHoldSha256,
        pointReservationSha256: marker.pointReservationSha256,
        controller: marker.controller,
        queueGeneration: marker.queueDrain.generation,
        sourceHoldIdentity: current.sourceHoldIdentity,
      };
      const bytes = Buffer.from(canonicalPublicationJson(value));
      const terminalSha256 = await boundSourceRecord(
        control.dataDir,
        marker.id,
        'abort-terminal.json',
        bytes,
        () => abortSource(control, signal),
        signal,
      );
      control.terminalBytes = bytes;
      return { id: marker.id, preparationSha256: marker.preparationSha256, decisionSha256: details.decisionSha256, terminalSha256, sourceHoldSha256 };
    })();
    return control.terminal;
  });
}

export function resumeCoreCaptureSourceAfterAbort(
  source: SourceHold,
  token: VerifiedCoreAbortApproval,
  queue: Pick<QueueFactory, 'resumeCoreCapturePause'>,
  signal: AbortSignal,
) {
  const control = sourceControls.get(source);
  if (!control || !control.sealed || !control.terminal || !control.intent || control.settled) return Promise.reject(fail());
  return useVerifiedCoreAbortApproval(token, async (details) => {
    const terminal = await control.terminal;
    if (
      !terminal ||
      !control.terminalBytes ||
      details.state !== 'verified-abort-awaiting-continuation' ||
      ['id', 'preparationSha256', 'decisionSha256', 'terminalSha256', 'sourceHoldSha256'].some(
        (key) => Reflect.get(terminal, key) !== Reflect.get(details, key),
      ) ||
      details.sourceSha256 !== control.intent?.sourceSha256 ||
      details.pointReservationSha256 !== control.intent.pointReservationSha256 ||
      canonicalPublicationJson(details.controller) !== canonicalPublicationJson(control.intent.controller)
    )
      throw fail();
    if (control.approval && canonicalPublicationJson(control.approval) !== canonicalPublicationJson(details)) throw fail();
    control.approval = details;
    const terminalBytes = control.terminalBytes;
    control.continuation ??= (async () => {
      await boundSourceRecord(control.dataDir, terminal.id, 'abort-terminal.json', terminalBytes, () => abortSource(control, signal), signal, false);
      const proof = await queue.resumeCoreCapturePause(control.paused, signal);
      control.queueProof = proof;
      const marker = JSON.parse(control.bytes.toString('utf8')) as Marker;
      if (proof.pauseId !== marker.drainReservationId || proof.queueGeneration !== marker.queueDrain.generation) throw fail();
      const value = {
        schema: 'orbis.core-capture-source-abort-continuation.v1',
        id: details.id,
        preparationSha256: details.preparationSha256,
        decisionSha256: details.decisionSha256,
        terminalSha256: details.terminalSha256,
        approvalSha256: details.approvalSha256,
        sourceHoldSha256: details.sourceHoldSha256,
        pointReservationSha256: details.pointReservationSha256,
        controller: details.controller,
        queueGeneration: proof.queueGeneration,
        queues: proof.queues,
      };
      const continuationSha256 = await boundSourceRecord(
        control.dataDir,
        terminal.id,
        'abort-continuation-ready.json',
        Buffer.from(canonicalPublicationJson(value)),
        async () => {
          await abortSource(control, signal);
          await proof.recheck();
        },
        signal,
      );
      return { id: terminal.id, continuationSha256 };
    })();
    return control.continuation;
  });
}

export async function settleCoreCaptureSourceAbort(source: SourceHold, token: VerifiedCoreAbortComplete, signal: AbortSignal) {
  const control = sourceControls.get(source);
  if (!control || control.settled || !control.approval || !control.continuation || !control.queueProof) throw fail();
  const approval = control.approval;
  const queueProof = control.queueProof;
  const ready = await control.continuation;
  await settleCoreCaptureAbortRecovery(token, async (details) => {
    signal.throwIfAborted();
    if (
      !ready ||
      details.state !== 'complete' ||
      details.continuationSha256 !== ready.continuationSha256 ||
      [
        'id',
        'preparationSha256',
        'decisionSha256',
        'terminalSha256',
        'approvalSha256',
        'sourceSha256',
        'sourceHoldSha256',
        'pointReservationSha256',
        'controller',
      ].some((key) => canonicalPublicationJson(Reflect.get(details, key)) !== canonicalPublicationJson(Reflect.get(approval, key)))
    )
      throw fail();
    const dir = await directory(control.dataDir, false);
    try {
      try {
        await fs.lstat(dir.at);
        throw fail();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const retired = await readMarker(`/proc/self/fd/${dir.parent.fd}/source-hold-retired-${details.id}.json`);
      if (
        !control.bytes.equals(retired.bytes) ||
        ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs'].some(
          (key) => Reflect.get(control.seal, key) !== Reflect.get(retired.seal, key),
        )
      )
        throw fail();
      await dir.recheck();
      await queueProof.recheck();
      signal.throwIfAborted();
    } finally {
      await dir.close();
    }
  });
  control.settled = true;
  control.release();
}

export type CoreCaptureContinuationQueueCheck = {
  queueGeneration: number;
  queues: { name: string; messages: number; consumers: number }[];
  recheck: () => Promise<void>;
};

export async function writeCoreCaptureContinuation(
  dataDir: string,
  details: CoreCaptureCompletionDetails,
  queueCheck: CoreCaptureContinuationQueueCheck,
  signal: AbortSignal,
): Promise<{ id: string; continuationSha256: string }> {
  const dir = await directory(dataDir, false);
  let child: FileHandle | undefined;
  try {
    const original = await readMarker(dir.at);
    const marker = original.value;
    if (
      marker.schema !== 'orbis.core-capture-source-hold.v2' ||
      marker.id !== details.id ||
      marker.sourceSha256 !== details.sourceSha256 ||
      createHash('sha256').update(original.bytes).digest('hex') !== details.sourceHoldSha256 ||
      marker.pointReservationSha256 !== details.pointReservationSha256 ||
      !validString(details.completionSha256, hash)
    )
      throw fail();
    const queues = queueCheck.queues.map((q) => ({ ...q }));
    const generation = queueCheck.queueGeneration;
    if (
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      queues.length !== 3 ||
      queues.some((q) => !exact(q, ['name', 'messages', 'consumers']) || q.messages !== 0 || q.consumers !== 1) ||
      queues
        .map((q) => q.name)
        .sort()
        .join(',') !== names.join(',')
    )
      throw fail();
    const queueSeal = canonicalPublicationJson(queues);
    const verify = async () => {
      signal.throwIfAborted();
      await queueCheck.recheck();
      signal.throwIfAborted();
      if (queueCheck.queueGeneration !== generation || canonicalPublicationJson(queueCheck.queues) !== queueSeal) throw fail();
      const current = await readMarker(dir.at);
      if (!identity(original.seal, current.seal) || !current.bytes.equals(original.bytes)) throw fail();
      await dir.recheck();
    };
    await verify();
    const childPath = `/proc/self/fd/${dir.parent.fd}/${details.id}`;
    await fs.mkdir(childPath, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
    const childSeal = await fs.lstat(childPath);
    if (!childSeal.isDirectory() || childSeal.isSymbolicLink() || !own(childSeal.uid) || (childSeal.mode & 0o7777) !== 0o700) throw fail();
    child = await fs.open(childPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!identity(childSeal, await child.stat())) throw fail();
    const openedChild = child;
    const recheckChild = async () => {
      if (!directoryIdentity(childSeal, await openedChild.stat()) || !directoryIdentity(childSeal, await fs.lstat(childPath))) throw fail();
    };
    const bytes = Buffer.from(
      canonicalPublicationJson({
        schema: 'orbis.core-capture-source-continuation.v1',
        id: details.id,
        completionSha256: details.completionSha256,
        sourceHoldSha256: details.sourceHoldSha256,
        pointReservationSha256: details.pointReservationSha256,
        controller: details.controller,
        queueGeneration: generation,
        queues,
      }),
    );
    const at = `/proc/self/fd/${child.fd}/continuation-ready.json`;
    const readReady = async () => {
      const handle = await fs.open(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await handle.stat();
        if (!before.isFile() || !own(before.uid) || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600 || before.size !== bytes.length)
          throw fail();
        const bounded = Buffer.alloc(bytes.length + 1);
        let count = 0;
        while (count < bounded.length) {
          const result = await handle.read(bounded, count, bounded.length - count, null);
          if (!result.bytesRead) break;
          count += result.bytesRead;
        }
        if (
          count !== bytes.length ||
          !bounded.subarray(0, count).equals(bytes) ||
          !identity(before, await handle.stat()) ||
          !identity(before, await fs.lstat(at))
        )
          throw fail();
        return before;
      } finally {
        await handle.close();
      }
    };
    await recheckChild();
    signal.throwIfAborted();
    try {
      const output = await fs.open(at, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await output.writeFile(bytes);
        await output.sync();
      } finally {
        await output.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const written = await readReady();
    await child.sync();
    await dir.parent.sync();
    await verify();
    await recheckChild();
    if (!identity(written, await readReady())) throw fail();
    signal.throwIfAborted();
    return { id: details.id, continuationSha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await child?.close();
    await dir.close();
  }
}
