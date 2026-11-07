import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { backupMaintenanceActive } from '@/common/backup-maintenance';
import { installationMode } from '@/common/installation-mode';
import type { AuthService } from '../auth/auth.service';
import type { AccountSecurityService } from '../auth/account-security.service';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import type { HostCoreCaptureStartClient } from '../host-updates/host-core-capture-start-client';
import type { HostCoreCaptureReservedStartClient } from '../host-updates/host-core-capture-reserved-start-client';
import type { QueueFactory } from '../queue/queue.factory';
import { authorizeBackupActionSession } from './backup-session-authorization';
import {
  coreCaptureSourceFailureWasUnwound,
  prepareCoreCaptureSourceHold,
  createReservedCoreCaptureSourceAttempt,
  startReservedCoreCaptureSourceAttempt,
  type ReservedCoreCaptureSourceAttempt,
} from './time-machine-core-source-hold';
import { cancelReservedCoreCapture } from './time-machine-core-early-abort';
import { readCoreCapturePublisher, rememberCoreCapturePublisher } from './time-machine-core-publisher';
import type { StoredCoreTimeMachinePoint, TimeMachineStore } from './time-machine-store';
import { coreCapturePointReservationSha256 } from './time-machine-core-reservation';

declare const operatorGrant: unique symbol;
export type CoreCaptureOperatorGrant = { readonly [operatorGrant]: true };
const issued = new WeakMap<CoreCaptureOperatorGrant, { ownerId: number; id: string; recheck: () => Promise<void> }>();
const fail = () => new Error('The snapshot could not be started.');
export class CoreCaptureCapabilityError extends Error {}
export class CoreCaptureReservationError extends Error {}

export async function authorizeCoreCaptureOperator(options: {
  auth: AuthService;
  security: AccountSecurityService;
  request: Request;
  ownerId: number;
  credentials?: { password: string; totpCode?: string };
}) {
  const { auth, security, request, ownerId } = options;
  const actor = await authorizeBackupActionSession(auth, security, request, ownerId, options.credentials);
  const grant = Object.freeze({}) as CoreCaptureOperatorGrant;
  issued.set(grant, {
    ownerId,
    // This is an audit correlation, not a user credential or proof understood by the host.
    id: randomUUID(),
    recheck: async () => {
      await authorizeBackupActionSession(auth, security, request, ownerId, undefined, 'backup', actor);
    },
  });
  return grant;
}

type ReservedClient = Pick<HostCoreCaptureReservedStartClient, 'preparationVersion' | 'abortClients' | 'requireCapability' | 'prepare' | 'admit'>;
type LegacyClient = Pick<HostCoreCaptureStartClient, 'requireCapability' | 'prepare' | 'admit'>;
type ReservedQueue = Parameters<typeof createReservedCoreCaptureSourceAttempt>[3];
function reservedClient(client: LegacyClient | ReservedClient): client is ReservedClient {
  return 'preparationVersion' in client && client.preparationVersion === 3;
}
function requireReservedQueue(queue: Options['queue']): asserts queue is ReservedQueue {
  for (const name of [
    'pauseForBackup',
    'resumeCoreCapturePause',
    'recheckCoreCapturePause',
    'verifyCoreCaptureSetupUnwind',
    'createCoreCaptureQueueSetup',
    'verifyCoreCaptureSetupRefusal',
  ])
    if (typeof Reflect.get(queue, name) !== 'function') throw fail();
}
type Options = {
  dataDirectory: string;
  store: TimeMachineStore;
  client: LegacyClient | ReservedClient;
  queue: Pick<QueueFactory, 'pauseForBackup'>;
  grant: CoreCaptureOperatorGrant;
  onboardingAttemptId?: string;
  buildDraft: (point: StoredCoreTimeMachinePoint, signal: AbortSignal) => Promise<unknown>;
  onStage?: (stage: 'preparing' | 'saving-preview' | 'capturing-core') => void;
};

/** The caller sends its accepted point before invoking start; admission itself is never replayed. */
export class CoreCaptureProducer {
  private reservation?: Promise<StoredCoreTimeMachinePoint>;
  private execution?: Promise<void>;
  private point?: StoredCoreTimeMachinePoint;
  private sourceAttempt?: ReservedCoreCaptureSourceAttempt;
  private authorization?: { ownerId: number; id: string; recheck: () => Promise<void> };

  constructor(private readonly options: Options) {}

  reserve(signal: AbortSignal): Promise<StoredCoreTimeMachinePoint> {
    this.reservation ??= this.reserveOnce(signal);
    return this.reservation;
  }

  private async reserveOnce(signal: AbortSignal) {
    signal.throwIfAborted();
    if (backupMaintenanceActive() || installationMode().phase !== 'normal') throw fail();
    const authorization = issued.get(this.options.grant);
    if (!authorization) throw fail();
    issued.delete(this.options.grant);
    await authorization.recheck();
    if (reservedClient(this.options.client)) requireReservedQueue(this.options.queue);
    try {
      await this.options.client.requireCapability(signal);
    } catch (error) {
      signal.throwIfAborted();
      throw new CoreCaptureCapabilityError(error instanceof Error ? error.message : 'Core capture is unavailable.', { cause: error });
    }
    await authorization.recheck();
    signal.throwIfAborted();
    if (backupMaintenanceActive() || installationMode().phase !== 'normal') throw fail();
    const attemptId = this.options.onboardingAttemptId;
    if (attemptId && !(await this.options.store.onboardingAttempt(attemptId, authorization.ownerId, true)).claimed) throw fail();
    const created = await this.options.store.create(authorization.ownerId, 3, attemptId).catch((error: unknown) => {
      if (attemptId) throw new CoreCaptureReservationError('The reserved setup capture needs recovery.', { cause: error });
      throw error;
    });
    this.point = created.point;
    this.authorization = authorization;
    return created.point;
  }

  start(signal: AbortSignal): Promise<void> {
    this.execution ??= Promise.resolve().then(() => this.startOnce(signal));
    return this.execution;
  }

  private async startOnce(signal: AbortSignal) {
    const point = this.point;
    const authorization = this.authorization;
    if (!point || !authorization) throw fail();
    let drainAttempted = false;
    let reservedPreparationAttempted = false;
    let admissionAttempted = false;
    let attempt: ReservedCoreCaptureSourceAttempt | undefined;
    let approvedReserved: Awaited<ReturnType<ReservedClient['prepare']>> | undefined;
    const selectedClient = this.options.client;
    try {
      signal.throwIfAborted();
      await authorization.recheck();
      this.options.onStage?.('preparing');
      const reservation = coreCapturePointReservationSha256(point);
      if (reservedClient(selectedClient)) {
        requireReservedQueue(this.options.queue);
        reservedPreparationAttempted = true;
        approvedReserved = await selectedClient.prepare(point.id, reservation, signal);
      }
      const approved = approvedReserved ?? (await (selectedClient as LegacyClient).prepare(point.id, reservation, signal));
      const publisherBinding = {
        id: point.id,
        preparationSha256: approved.preparation.preparationSha256,
        sourceSha256: approved.preparation.sourceSha256,
        pointReservationSha256: approved.preparation.pointReservationSha256,
        controller: approved.preparation.controller,
      };
      if (approvedReserved) {
        requireReservedQueue(this.options.queue);
        attempt = createReservedCoreCaptureSourceAttempt(
          this.options.dataDirectory,
          approvedReserved.preparation,
          authorization.id,
          this.options.queue,
        );
        this.sourceAttempt = attempt;
      }
      if (approved.publisher === 'sentinel.v1') await rememberCoreCapturePublisher(this.options.dataDirectory, publisherBinding, signal);
      await authorization.recheck();
      drainAttempted = true;
      const beforeMarker = async () => {
        await authorization.recheck();
        this.options.onStage?.('saving-preview');
        await this.options.buildDraft(point, signal);
        await this.options.store.readCoreDraft(point, signal);
        await authorization.recheck();
      };
      const source = attempt
        ? await startReservedCoreCaptureSourceAttempt(attempt, signal, beforeMarker)
        : await prepareCoreCaptureSourceHold(
            this.options.dataDirectory,
            {
              id: approved.preparation.id,
              preparationSha256: approved.preparation.preparationSha256,
              sourceSha256: approved.preparation.sourceSha256,
              pointReservationSha256: approved.preparation.pointReservationSha256,
              controller: approved.preparation.controller,
              operatorAuthorizationId: authorization.id,
            },
            this.options.queue,
            signal,
            beforeMarker,
          );
      this.options.onStage?.('capturing-core');
      await source.handoff(async () => {
        await authorization.recheck();
        if (approved.publisher === 'sentinel.v1' && (await readCoreCapturePublisher(this.options.dataDirectory, publisherBinding)) !== 'sentinel.v1')
          throw fail();
        admissionAttempted = true;
        return approvedReserved && reservedClient(selectedClient)
          ? selectedClient.admit(approvedReserved.token, source.sourceHoldSha256, signal)
          : (selectedClient as LegacyClient).admit(approved.token as Parameters<LegacyClient['admit']>[0], source.sourceHoldSha256, signal);
      });
    } catch (error) {
      let reservedAbortComplete = false;
      if (this.sourceAttempt && approvedReserved && reservedClient(selectedClient) && !admissionAttempted) {
        try {
          requireReservedQueue(this.options.queue);
          const result = await cancelReservedCoreCapture(this.sourceAttempt, {
            ...selectedClient.abortClients,
            preparation: approvedReserved.preparation,
            queue: this.options.queue,
            signal: AbortSignal.timeout(120_000),
          });
          reservedAbortComplete = result.id === point.id && result.state === 'complete';
        } catch {
          // The original point and retained attempt remain available for recovery.
        }
      }
      if (
        (reservedPreparationAttempted ? reservedAbortComplete : !drainAttempted || coreCaptureSourceFailureWasUnwound(error)) &&
        canonicalPublicationJson(await this.options.store.load(point.id)) === canonicalPublicationJson(point)
      )
        await this.options.store.fail(point, 'capture-failed');
      // Once marker creation is attempted, only root reconciliation may release the hold.
      throw error;
    }
  }
}
