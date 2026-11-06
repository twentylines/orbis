import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { useVerifiedCoreAbortIntent, type VerifiedCoreAbortIntent } from '../host-updates/host-core-capture-abort-client';
import type {
  HostCoreCaptureRefusedAbortClient,
  HostCoreCaptureSetupAbortClient,
  HostCoreCaptureUnusedAbortClient,
} from '../host-updates/host-core-capture-unused-abort-client';
import {
  stopReservedCoreCaptureSourceAttempt,
  selectReservedCoreCaptureSetupRefusal,
  openCoreCaptureSourceDirectory,
  persistBoundCoreCaptureSourceRecord,
  type ReservedCoreCaptureSourceAttempt,
} from './time-machine-core-source-hold';

const fail = () => new Error('Snapshot cancellation requires review.');
type Unused = Extract<Awaited<ReturnType<typeof stopReservedCoreCaptureSourceAttempt>>, { kind: 'unused' | 'setup-unwound' | 'setup-refused' }>;
type MarkerAbsentClient = HostCoreCaptureUnusedAbortClient | HostCoreCaptureSetupAbortClient | HostCoreCaptureRefusedAbortClient;
async function verify(attempt: ReservedCoreCaptureSourceAttempt, expected: Unused, signal: AbortSignal, create = false) {
  signal.throwIfAborted();
  const current = await stopReservedCoreCaptureSourceAttempt(attempt, signal);
  if (current.kind !== expected.kind || canonicalPublicationJson(current) !== canonicalPublicationJson(expected)) throw fail();
  const dir = await openCoreCaptureSourceDirectory(expected.dataDirectory, create);
  try {
    for (const at of [dir.at, `/proc/self/fd/${dir.parent.fd}/source-hold-retired-${expected.preparation.id}.json`]) {
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

async function settleMarkerAbsentCoreCapture(
  attempt: ReservedCoreCaptureSourceAttempt,
  intent: VerifiedCoreAbortIntent,
  client: MarkerAbsentClient,
  signal: AbortSignal,
  kind: Unused['kind'],
) {
  const unused = await stopReservedCoreCaptureSourceAttempt(attempt, signal);
  if (unused.kind !== kind || !['unused', 'setup-unwound', 'setup-refused'].includes(unused.kind)) throw fail();
  const evidence = await useVerifiedCoreAbortIntent(intent, async (details) => {
    if (
      ['id', 'preparationSha256', 'sourceSha256', 'pointReservationSha256', 'controller'].some(
        (key) => canonicalPublicationJson(Reflect.get(unused.preparation, key)) !== canonicalPublicationJson(Reflect.get(details, key)),
      )
    )
      throw fail();
    await verify(attempt, unused, signal, true);
    if (unused.kind === 'setup-refused') await selectReservedCoreCaptureSetupRefusal(attempt, unused, signal);
    const bytes = Buffer.from(
      canonicalPublicationJson({
        schema:
          unused.kind === 'unused'
            ? 'orbis.core-capture-source-abort-terminal.v3'
            : unused.kind === 'setup-unwound'
              ? 'orbis.core-capture-source-abort-terminal.v4'
              : 'orbis.core-capture-source-abort-terminal.v5',
        id: details.id,
        preparationSha256: details.preparationSha256,
        decisionSha256: details.decisionSha256,
        pointReservationSha256: details.pointReservationSha256,
        controller: details.controller,
        operatorAuthorizationId: unused.operatorAuthorizationId,
        sourceMarker: 'absent',
        sourceAttempt: unused.kind === 'unused' ? 'not-started' : unused.kind,
        ...(unused.kind === 'setup-unwound' ? { localLease: 'not-acquired', queueUnwind: unused.queueUnwind } : {}),
        ...(unused.kind === 'setup-refused' ? { localLease: 'not-acquired', queueRefusal: unused.queueRefusal } : {}),
      }),
    );
    await persistBoundCoreCaptureSourceRecord(
      unused.dataDirectory,
      details.id,
      'abort-terminal.json',
      bytes,
      () => verify(attempt, unused, signal),
      signal,
    );
    return { bytes, terminalSha256: createHash('sha256').update(bytes).digest('hex'), decisionSha256: details.decisionSha256 };
  });
  let complete: Awaited<ReturnType<MarkerAbsentClient['settle']>>;
  try {
    complete = await client.settle(unused.preparation, evidence.decisionSha256, evidence.terminalSha256, signal);
  } catch (error) {
    const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    if (!code || !('value' in code) || !['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code.value)) throw error;
    complete = await client.status(unused.preparation, evidence.decisionSha256, evidence.terminalSha256, signal);
  }
  if (
    unused.kind === 'setup-unwound' &&
    (!('queueUnwind' in complete) || canonicalPublicationJson(complete.queueUnwind) !== canonicalPublicationJson(unused.queueUnwind))
  )
    throw fail();
  if (
    unused.kind === 'setup-refused' &&
    (!('queueRefusal' in complete) || canonicalPublicationJson(complete.queueRefusal) !== canonicalPublicationJson(unused.queueRefusal))
  )
    throw fail();
  await persistBoundCoreCaptureSourceRecord(
    unused.dataDirectory,
    unused.preparation.id,
    'abort-terminal.json',
    evidence.bytes,
    () => verify(attempt, unused, signal),
    signal,
    false,
  );
  return {
    id: unused.preparation.id,
    state: 'complete' as const,
    sourceAttempt: unused.kind === 'unused' ? ('not-started' as const) : unused.kind,
  };
}

export function settleUnusedCoreCapture(
  attempt: ReservedCoreCaptureSourceAttempt,
  intent: VerifiedCoreAbortIntent,
  client: HostCoreCaptureUnusedAbortClient,
  signal: AbortSignal,
) {
  return settleMarkerAbsentCoreCapture(attempt, intent, client, signal, 'unused');
}

export function settleUnwoundCoreCapture(
  attempt: ReservedCoreCaptureSourceAttempt,
  intent: VerifiedCoreAbortIntent,
  client: HostCoreCaptureSetupAbortClient,
  signal: AbortSignal,
) {
  return settleMarkerAbsentCoreCapture(attempt, intent, client, signal, 'setup-unwound');
}

export function settleRefusedCoreCapture(
  attempt: ReservedCoreCaptureSourceAttempt,
  intent: VerifiedCoreAbortIntent,
  client: HostCoreCaptureRefusedAbortClient,
  signal: AbortSignal,
) {
  return settleMarkerAbsentCoreCapture(attempt, intent, client, signal, 'setup-refused');
}
