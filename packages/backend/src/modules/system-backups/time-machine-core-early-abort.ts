import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { HostCoreCaptureEmptyAbortClient } from '../host-updates/host-core-capture-empty-abort-client';
import type {
  HostCoreCaptureRefusedAbortClient,
  HostCoreCaptureSetupAbortClient,
  HostCoreCaptureUnusedAbortClient,
} from '../host-updates/host-core-capture-unused-abort-client';
import { settleRefusedCoreCapture, settleUnusedCoreCapture, settleUnwoundCoreCapture } from './time-machine-core-unused-abort';
import {
  useVerifiedCoreAbortIntent,
  type VerifiedCoreAbortIntent,
  type HostCoreCaptureAbortClient,
  type CoreCaptureAbortPreparation,
} from '../host-updates/host-core-capture-abort-client';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { cancelLiveCoreCapture, cancelLiveCoreCaptureAfterIntent } from './time-machine-core-abort';
import type { QueueFactory } from '../queue/queue.factory';
import {
  type ReservedCoreCaptureSourceAttempt,
  stopReservedCoreCaptureSourceAttempt,
  reconcileReservedCoreCaptureSourceMarker,
  resumeReservedCoreCaptureSourceAttempt,
  settleReservedCoreCaptureSourceAttempt,
  openCoreCaptureSourceDirectory,
  persistBoundCoreCaptureSourceRecord,
} from './time-machine-core-source-hold';

type Snapshot = Extract<Awaited<ReturnType<typeof stopReservedCoreCaptureSourceAttempt>>, { kind: 'absent' }>;
const fail = () => new Error('Early capture recovery requires review.');
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function absent(snapshot: Snapshot, signal: AbortSignal, create = false) {
  signal.throwIfAborted();
  const dir = await openCoreCaptureSourceDirectory(snapshot.dataDirectory, create);
  try {
    for (const at of [dir.at, `/proc/self/fd/${dir.parent.fd}/source-hold-retired-${snapshot.preparation.id}.json`]) {
      try {
        await fs.lstat(at);
        throw fail();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await dir.recheck();
    signal.throwIfAborted();
  } finally {
    await dir.close();
  }
}
type Evidence = { snapshot: Snapshot; terminal: Buffer; decisionSha256: string; terminalSha256: string; ready?: Buffer };
const evidence = new WeakMap<ReservedCoreCaptureSourceAttempt, Promise<Evidence>>();
async function terminal(attempt: ReservedCoreCaptureSourceAttempt, token: VerifiedCoreAbortIntent, signal: AbortSignal) {
  const snapshot = await stopReservedCoreCaptureSourceAttempt(attempt);
  if (snapshot.kind !== 'absent') throw fail();
  return useVerifiedCoreAbortIntent(token, async (details) => {
    if (
      ['id', 'preparationSha256', 'sourceSha256', 'pointReservationSha256', 'controller'].some(
        (key) => canonicalPublicationJson(Reflect.get(snapshot.preparation, key)) !== canonicalPublicationJson(Reflect.get(details, key)),
      )
    )
      throw fail();
    let pending = evidence.get(attempt);
    if (!pending) {
      pending = (async () => {
        await absent(snapshot, signal, true);
        const value = {
          schema: 'orbis.core-capture-source-abort-terminal.v2',
          id: details.id,
          preparationSha256: details.preparationSha256,
          decisionSha256: details.decisionSha256,
          pointReservationSha256: details.pointReservationSha256,
          controller: details.controller,
          operatorAuthorizationId: snapshot.operatorAuthorizationId,
          drainReservationId: snapshot.drainReservationId,
          queueGeneration: snapshot.queueGeneration,
          queues: snapshot.queues,
          sourceMarker: 'absent',
        };
        const bytes = Buffer.from(canonicalPublicationJson(value));
        await persistBoundCoreCaptureSourceRecord(
          snapshot.dataDirectory,
          details.id,
          'abort-terminal.json',
          bytes,
          () => absent(snapshot, signal),
          signal,
        );
        return { snapshot, terminal: bytes, terminalSha256: hash(bytes), decisionSha256: details.decisionSha256 };
      })();
      evidence.set(attempt, pending);
    }
    const result = await pending;
    if (result.decisionSha256 !== details.decisionSha256) throw fail();
    return result;
  });
}
type Options = {
  preparation: CoreCaptureAbortPreparation;
  client: HostCoreCaptureEmptyAbortClient;
  completeClient: HostCoreCaptureAbortClient;
  unusedClient?: HostCoreCaptureUnusedAbortClient;
  setupClient?: HostCoreCaptureSetupAbortClient;
  refusedClient?: HostCoreCaptureRefusedAbortClient;
  queue: Pick<QueueFactory, 'resumeCoreCapturePause'>;
  signal: AbortSignal;
};
type Result =
  | { id: string; state: 'complete'; continuationSha256: string }
  | { id: string; state: 'complete'; sourceAttempt: 'not-started' | 'setup-unwound' | 'setup-refused' };
const attempts = new WeakMap<ReservedCoreCaptureSourceAttempt, Promise<Result>>();
const observable = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const code = Object.getOwnPropertyDescriptor(error, 'code');
  return !!code && 'value' in code && ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code.value);
};

/** Selects the observed producer phase; a missing marker never selects recovery by itself. */
export function cancelReservedCoreCapture(attempt: ReservedCoreCaptureSourceAttempt, options: Options): Promise<Result> {
  const existing = attempts.get(attempt);
  if (existing) return existing;
  let rootAttempted = false;
  const pending = (async (): Promise<Result> => {
    const { client, signal, preparation } = options;
    signal.throwIfAborted();
    const stopped = await stopReservedCoreCaptureSourceAttempt(attempt, signal);
    if (stopped.kind === 'complete') {
      rootAttempted = true;
      return cancelLiveCoreCapture(stopped.source, { client: options.completeClient, preparation, queue: options.queue, signal });
    }
    if (canonicalPublicationJson(stopped.preparation) !== canonicalPublicationJson(preparation)) throw fail();
    if (stopped.kind === 'unused' && !options.unusedClient) throw fail();
    if (stopped.kind === 'setup-unwound' && !options.setupClient) throw fail();
    const refusedClient = options.refusedClient;
    if (stopped.kind === 'setup-refused' && !refusedClient) throw fail();
    let identity: string | undefined;
    if (stopped.kind === 'setup-refused') {
      if (!refusedClient) throw fail();
      identity = await refusedClient.requireCapability(signal);
    }
    rootAttempted = true;
    const intent = await (identity ? client.intent(preparation, signal, identity) : client.intent(preparation, signal)).catch((error) => {
      if (!observable(error)) throw error;
      return identity ? client.observeIntent(preparation, signal, identity) : client.observeIntent(preparation, signal);
    });
    if (stopped.kind === 'unused') {
      if (!options.unusedClient) throw fail();
      return settleUnusedCoreCapture(attempt, intent.token, options.unusedClient, signal);
    }
    if (stopped.kind === 'setup-unwound') {
      if (!options.setupClient) throw fail();
      return settleUnwoundCoreCapture(attempt, intent.token, options.setupClient, signal);
    }
    if (stopped.kind === 'setup-refused') {
      if (!refusedClient) throw fail();
      return settleRefusedCoreCapture(attempt, intent.token, refusedClient, signal);
    }
    if (stopped.kind === 'interrupted') {
      const source = await reconcileReservedCoreCaptureSourceMarker(attempt, intent.token, signal);
      return cancelLiveCoreCaptureAfterIntent(source, { client: options.completeClient, preparation, queue: options.queue, signal });
    }
    const record = await terminal(attempt, intent.token, signal);
    const approved = await client.prepare(preparation, record.decisionSha256, record.terminalSha256, signal).catch((error) => {
      if (!observable(error)) throw error;
      return client.observeApproval(preparation, record.decisionSha256, record.terminalSha256, signal);
    });
    await persistBoundCoreCaptureSourceRecord(
      stopped.dataDirectory,
      preparation.id,
      'abort-terminal.json',
      record.terminal,
      () => absent(stopped, signal),
      signal,
      false,
    );
    const ready = await resumeReservedCoreCaptureSourceAttempt(
      attempt,
      approved.token,
      async (details, proof) => {
        const value = {
          schema: 'orbis.core-capture-source-abort-continuation.v2',
          id: details.id,
          preparationSha256: details.preparationSha256,
          decisionSha256: details.decisionSha256,
          terminalSha256: details.terminalSha256,
          approvalSha256: details.approvalSha256,
          pointReservationSha256: details.pointReservationSha256,
          controller: details.controller,
          queueGeneration: proof.queueGeneration,
          queues: proof.queues,
          sourceMarker: 'absent',
        };
        const bytes = Buffer.from(canonicalPublicationJson(value));
        const continuationSha256 = await persistBoundCoreCaptureSourceRecord(
          stopped.dataDirectory,
          preparation.id,
          'abort-continuation-ready.json',
          bytes,
          async () => {
            await absent(stopped, signal);
            await proof.recheck();
          },
          signal,
        );
        record.ready = bytes;
        return { id: preparation.id, continuationSha256 };
      },
      signal,
    );
    const complete = await client.finish(approved.details, ready.continuationSha256, signal).catch((error) => {
      if (!observable(error)) throw error;
      return client.observeComplete(approved.details, ready.continuationSha256, signal);
    });
    await settleReservedCoreCaptureSourceAttempt(
      attempt,
      complete.token,
      async () => {
        await absent(stopped, signal);
        if (!record.ready) throw fail();
        await persistBoundCoreCaptureSourceRecord(
          stopped.dataDirectory,
          preparation.id,
          'abort-terminal.json',
          record.terminal,
          () => absent(stopped, signal),
          signal,
          false,
        );
        await persistBoundCoreCaptureSourceRecord(
          stopped.dataDirectory,
          preparation.id,
          'abort-continuation-ready.json',
          record.ready,
          () => absent(stopped, signal),
          signal,
          false,
        );
      },
      signal,
    );
    return { id: preparation.id, state: 'complete', continuationSha256: ready.continuationSha256 };
  })();
  attempts.set(attempt, pending);
  void pending.catch(() => {
    if (!rootAttempted && attempts.get(attempt) === pending) attempts.delete(attempt);
  });
  return pending;
}
