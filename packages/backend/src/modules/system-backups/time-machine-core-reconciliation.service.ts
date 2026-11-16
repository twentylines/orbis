import { ConflictException, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import { timeMachineIdSchema } from '@runtipi/common/schemas/time-machine';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import { enterBackupMutation } from '@/common/backup-maintenance';
import { acquireBackupDisk } from '@/common/backup-disk';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AuthService } from '../auth/auth.service';
import { TimeMachineService } from './time-machine.service';
import { TimeMachineCorePreparationService } from './time-machine-core-preparation.service';
import { restoreStartupRole } from './backup-restore-startup';
import { CoreInspectionStore } from './time-machine-core-inspection.store';
import { CoreReconciliationStore, sameReconciliationInspection, type CoreReconciliationRecord } from './time-machine-core-reconciliation.store';
import { callCoreRestorationReviewRoot } from './time-machine-core-restoration-review-client';
import {
  callCoreBootstrapInspectionRoot,
  callCoreCleanTargetPreparationRoot,
  callCoreCleanTargetReconciliationRoot,
  type CoreCleanTargetReconciliationStatus,
} from './time-machine-core-bootstrap-client';

const fail = () => new ConflictException('Restore preparation needs attention. Your saved data is unchanged.');
type Actor = Awaited<ReturnType<AuthService['operatorActionContext']>>;
type Pending = { done: Promise<void>; uncertain: boolean; finished: boolean; release: () => void };
export type CoreReconciliationInput = {
  requestId: string;
  sourcePreparationRequestId: string;
  destinationPointId: string;
  destinationPreparationRequestId: string;
  action: 'prepare-isolated-reconciled-target';
};

@Injectable()
export class TimeMachineCoreReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly store: CoreReconciliationStore;
  private readonly sources: CoreInspectionStore;
  private readonly destinations: CoreInspectionStore;
  private readonly pending = new Map<string, Pending>();
  private readonly recovering = new Set<string>();
  private readonly shutdown = new AbortController();
  private storageUnverified = true;
  private startup?: Promise<void>;
  constructor(
    config: ConfigurationService,
    private readonly auth: AuthService,
    private readonly timeMachine: TimeMachineService,
    private readonly preparations: TimeMachineCorePreparationService,
  ) {
    const directory = config.get('directories').dataDir;
    this.store = new CoreReconciliationStore(directory);
    this.sources = new CoreInspectionStore(directory, 'core-target-preparations');
    this.destinations = new CoreInspectionStore(directory, 'core-bootstrap-inspections');
    this.recoveryHold();
  }
  private recoveryHold() {
    this.preparations.setReconciliationRecoveryRequired(this.storageUnverified || this.recovering.size > 0);
  }
  onModuleInit() {
    return this.prepareStartup();
  }
  prepareStartup() {
    this.startup ??= this.recoverStartup();
    return this.startup;
  }
  private async recoverStartup() {
    if (restoreStartupRole() === 'verify') {
      this.storageUnverified = false;
      this.recoveryHold();
      return;
    }
    try {
      for (const record of await this.store.recoveryRecords()) {
        if (!(await this.store.marked(record, 'requested')) || (await this.store.marked(record, 'settled'))) continue;
        this.recovering.add(record.requestId);
        await this.savedRecords(record);
        try {
          const status = await callCoreCleanTargetReconciliationRoot({ ...this.options(record), action: 'status' });
          await this.observed(record, status);
        } catch {
          // Unknown Root ownership stays held. Startup never dispatches or replays work.
        }
      }
      this.storageUnverified = false;
    } catch {
      // Invalid or orphaned admissions must keep all backup mutations closed.
    }
    this.recoveryHold();
  }
  private async actor(request: Request, ownerId: number) {
    const actor = await this.auth.operatorActionContext(request);
    if (actor.userId !== ownerId) throw fail();
    return actor;
  }
  private async binding(pointId: string, ownerId: number, actor: Actor, request: Request) {
    if (!timeMachineIdSchema.allows(pointId)) throw fail();
    const point = await this.timeMachine.coreInspectionBindingPoint(pointId, ownerId, request);
    if (point.pointId !== pointId || point.ownerId !== ownerId) throw fail();
    return { ...point, actor: { ownerId, sessionBinding: actor.sessionBinding, securityBinding: actor.securityBinding } };
  }
  private async savedRecords(record: CoreReconciliationRecord) {
    for (const [store, saved] of [
      [this.sources, record.sourcePreparation],
      [this.destinations, record.sourceInspection],
      [this.destinations, record.destinationInspection],
    ] as const) {
      const current = await store.get(saved.requestId, saved);
      if (!current || !sameReconciliationInspection(current, saved) || !(await store.marked(saved.requestId, saved, 'requested'))) throw fail();
    }
    for (const inspection of [record.sourceInspection, record.destinationInspection]) {
      if (!(await this.destinations.marked(inspection.requestId, inspection, 'approval-requested'))) throw fail();
    }
  }
  private async current(request: Request, actor: Actor, record: CoreReconciliationRecord) {
    const fresh = await this.actor(request, record.sourcePreparation.ownerId);
    if (fresh.sessionBinding !== actor.sessionBinding || fresh.securityBinding !== actor.securityBinding) throw fail();
    for (const saved of [record.sourcePreparation, record.destinationInspection]) {
      const binding = await this.binding(saved.pointId, saved.ownerId, fresh, request);
      if (
        binding.archiveSha256 !== saved.archiveSha256 ||
        binding.manifestSha256 !== saved.manifestSha256 ||
        binding.actor.sessionBinding !== saved.actor.sessionBinding ||
        binding.actor.securityBinding !== saved.actor.securityBinding
      )
        throw fail();
    }
    await this.savedRecords(record);
  }
  private options(record: CoreReconciliationRecord) {
    return {
      id: record.id,
      sourcePreparationId: record.sourcePreparation.id,
      destinationInspectionId: record.destinationInspection.id,
      actor: record.sourcePreparation.actor,
      signal: this.shutdown.signal,
    };
  }
  private wrapper(record: CoreReconciliationRecord, state: string, status?: CoreCleanTargetReconciliationStatus) {
    return {
      schema: 'orbis.core-reconciliation-operation.v1' as const,
      requestId: record.requestId,
      id: record.id,
      pointId: record.sourcePreparation.pointId,
      destinationPointId: record.destinationInspection.pointId,
      ownerId: record.sourcePreparation.ownerId,
      state,
      destinationEvidence: 'saved-capture-only' as const,
      restoreSupported: false as const,
      activationAuthorized: false as const,
      reconciledTargetAvailable: status?.reconciledTargetAvailable === true,
      ...(status ? { status } : {}),
    };
  }
  private async observed(record: CoreReconciliationRecord, status: CoreCleanTargetReconciliationStatus) {
    if (status.reconciliationActive || !status.reconciledTargetAvailable || status.phase !== 'reconciliation-complete') return;
    await this.store.mark(record, 'settled');
    this.recovering.delete(record.requestId);
    this.recoveryHold();
    const pending = this.pending.get(record.requestId);
    if (pending) {
      pending.uncertain = false;
      if (pending.finished) pending.release();
    }
  }
  private async preflight(record: CoreReconciliationRecord) {
    const source = record.sourcePreparation;
    const prepared = await callCoreCleanTargetPreparationRoot({
      id: source.id,
      sourceInspectionId: record.sourceInspection.id,
      actor: source.actor,
      signal: this.shutdown.signal,
      action: 'status',
    });
    if (prepared.preparationActive || !prepared.preparedTargetAvailable || prepared.phase !== 'preparation-complete') throw fail();
    for (const inspection of [record.sourceInspection, record.destinationInspection]) {
      const inspected = await callCoreBootstrapInspectionRoot({
        id: inspection.id,
        pointId: inspection.pointId,
        manifestSha256: inspection.manifestSha256,
        actor: inspection.actor,
        signal: this.shutdown.signal,
        action: 'status',
      });
      if (inspected.phase !== 'inspection-complete' || !inspected.bootstrapCatalogAvailable) throw fail();
    }
  }
  private launch(request: Request, actor: Actor, record: CoreReconciliationRecord) {
    if (this.shutdown.signal.aborted || this.pending.has(record.requestId)) throw fail();
    const mutation = enterBackupMutation();
    if (!mutation) throw fail();
    let disk: () => void;
    try {
      disk = acquireBackupDisk();
    } catch (error) {
      mutation();
      throw error;
    }
    const background = {
      authMethod: request.authMethod,
      user: request.user ? { id: request.user.id, operator: request.user.operator } : undefined,
      cookies: { [SESSION_COOKIE_NAME]: request.cookies?.[SESSION_COOKIE_NAME] },
    } as unknown as Request;
    const pending: Pending = {
      done: Promise.resolve(),
      uncertain: false,
      finished: false,
      release: () => {
        disk();
        mutation();
        if (this.pending.get(record.requestId) === pending) this.pending.delete(record.requestId);
      },
    };
    this.pending.set(record.requestId, pending);
    pending.done = Promise.resolve()
      .then(async () => {
        await this.current(background, actor, record);
        await this.preflight(record);
        await this.current(background, actor, record);
        if (await this.store.marked(record, 'requested')) return;
        pending.uncertain = true;
        await this.store.mark(record, 'requested');
        let status = await callCoreCleanTargetReconciliationRoot({ ...this.options(record), action: 'prepare' });
        while (status.reconciliationActive) status = await callCoreCleanTargetReconciliationRoot({ ...this.options(record), action: 'wait' });
        await this.observed(record, status);
      })
      .catch(() => undefined)
      .finally(() => {
        pending.finished = true;
        if (!pending.uncertain) pending.release();
      });
    return this.wrapper(record, 'preparing-reconciliation');
  }
  async prepare(
    pointId: string,
    ownerId: number,
    request: Request,
    credentials: { password: string; totpCode?: string },
    input: CoreReconciliationInput,
  ) {
    if (
      input.action !== 'prepare-isolated-reconciled-target' ||
      ![input.requestId, input.sourcePreparationRequestId, input.destinationPreparationRequestId, input.destinationPointId].every((id) =>
        timeMachineIdSchema.allows(id),
      )
    )
      throw fail();
    const actor = await this.actor(request, ownerId);
    const sourceBinding = await this.binding(pointId, ownerId, actor, request);
    const destinationBinding = await this.binding(input.destinationPointId, ownerId, actor, request);
    const sourcePreparation = await this.sources.get(input.sourcePreparationRequestId, sourceBinding);
    const sourceInspection = await this.destinations.get(input.sourcePreparationRequestId, sourceBinding);
    const destinationInspection = await this.destinations.get(input.destinationPreparationRequestId, destinationBinding);
    if (
      !sourcePreparation ||
      !sourceInspection ||
      !destinationInspection ||
      sourcePreparation.version !== 2 ||
      sourceInspection.version !== 2 ||
      destinationInspection.version !== 2
    )
      throw fail();
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    const proposed = { version: 1 as const, id: '', requestId: input.requestId, sourcePreparation, sourceInspection, destinationInspection };
    await this.current(request, actor, proposed);
    const record = await this.store.reserve(input.requestId, { sourcePreparation, sourceInspection, destinationInspection });
    if (this.pending.has(record.requestId) || (await this.store.marked(record, 'requested')))
      return this.status(pointId, ownerId, request, record.requestId);
    return this.launch(request, actor, record);
  }
  async status(pointId: string, ownerId: number, request: Request, requestId: string) {
    const actor = await this.actor(request, ownerId);
    const record = await this.store.get(requestId);
    if (!record || record.sourcePreparation.pointId !== pointId || record.sourcePreparation.ownerId !== ownerId) throw fail();
    await this.current(request, actor, record);
    if (!(await this.store.marked(record, 'requested')))
      return this.wrapper(record, this.pending.has(requestId) ? 'preparing-reconciliation' : 'not-started');
    let status: CoreCleanTargetReconciliationStatus;
    try {
      status = await callCoreCleanTargetReconciliationRoot({ ...this.options(record), action: 'status' });
      await this.observed(record, status);
    } catch {
      await this.current(request, actor, record);
      return this.wrapper(record, 'recovery-required');
    }
    await this.current(request, actor, record);
    return this.wrapper(record, status.phase, status);
  }
  async restorationReview(
    pointId: string,
    ownerId: number,
    request: Request,
    requestId: string,
    reviewRequestId: string,
    action: 'review' | 'status',
  ) {
    if (!timeMachineIdSchema.allows(reviewRequestId) || !['review', 'status'].includes(action)) throw fail();
    this.shutdown.signal.throwIfAborted();
    const actor = await this.actor(request, ownerId);
    const record = await this.store.get(requestId);
    if (!record || record.sourcePreparation.pointId !== pointId || record.sourcePreparation.ownerId !== ownerId) throw fail();
    await this.current(request, actor, record);
    if (action === 'review') {
      if (!(await this.store.marked(record, 'requested'))) throw fail();
      const reconciliation = await callCoreCleanTargetReconciliationRoot({ ...this.options(record), action: 'status' });
      await this.observed(record, reconciliation);
      if (reconciliation.reconciliationActive || !reconciliation.reconciledTargetAvailable || reconciliation.phase !== 'reconciliation-complete')
        throw fail();
      await this.current(request, actor, record);
    }
    const review = await this.store.review(reviewRequestId, record, action === 'review');
    const status = review
      ? await callCoreRestorationReviewRoot({
          action,
          id: review.id,
          reconciliationId: record.id,
          actor: record.sourcePreparation.actor,
          signal: this.shutdown.signal,
        })
      : undefined;
    await this.current(request, actor, record);
    return {
      schema: 'orbis.core-restoration-review-operation.v1' as const,
      requestId,
      reviewRequestId,
      id: review?.id ?? null,
      pointId,
      destinationPointId: record.destinationInspection.pointId,
      destinationEvidence: 'saved-capture-only' as const,
      state: status?.phase ?? 'not-reviewed',
      reviewAvailable: status?.reviewAvailable === true,
      restoreSupported: false as const,
      activationAuthorized: false as const,
      logicalConsistencyProved: false as const,
      writerQuiescenceProved: false as const,
      ...(status ? { status } : {}),
    };
  }
  async onModuleDestroy() {
    this.shutdown.abort();
    await Promise.allSettled([...this.pending.values()].map((pending) => pending.done));
  }
}
