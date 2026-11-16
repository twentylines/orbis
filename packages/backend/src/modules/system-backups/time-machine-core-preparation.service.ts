import { ConflictException, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import { timeMachineIdSchema } from '@runtipi/common/schemas/time-machine';
import { SESSION_COOKIE_NAME } from '@/common/constants';
import { enterBackupMutation, setCorePreparationRecoveryRequired } from '@/common/backup-maintenance';
import { acquireBackupDisk } from '@/common/backup-disk';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AuthService } from '../auth/auth.service';
import { TimeMachineService } from './time-machine.service';
import { restoreStartupRole } from './backup-restore-startup';
import { CoreInspectionStore, type CoreInspectionBinding, type CoreInspectionRecord } from './time-machine-core-inspection.store';
import {
  callCoreBootstrapInspectionRoot,
  callCoreCleanTargetPreparationRoot,
  callCoreRestoreRuntimeRoot,
  type CoreBootstrapInspectionApproval,
  type CoreBootstrapInspectionStatus,
  type CoreCleanTargetPreparationStatus,
  type CoreRestoreRuntimeStatus,
} from './time-machine-core-bootstrap-client';

const fail = () => new ConflictException('Restore preparation needs attention. Your saved data is unchanged.');
type Actor = Awaited<ReturnType<AuthService['operatorActionContext']>>;
type Records = { inspection: CoreInspectionRecord; runtime: CoreInspectionRecord; target: CoreInspectionRecord };
type Stage = 'checking-support' | 'preparing' | 'authorizing' | 'preparing-target';
type Operation = 'runtime' | 'inspection' | 'target';
type Pending = {
  state: Stage | 'recovery-required';
  done: Promise<void>;
  uncertain: boolean;
  finished: boolean;
  operation?: Operation;
  release: () => void;
};
type Progress = { runtime?: CoreRestoreRuntimeStatus; inspection?: CoreBootstrapInspectionStatus; preparation?: CoreCleanTargetPreparationStatus };
const sameActor = (a: Actor, b: Actor) => a.userId === b.userId && a.sessionBinding === b.sessionBinding && a.securityBinding === b.securityBinding;

@Injectable()
export class TimeMachineCorePreparationService implements OnModuleDestroy, OnModuleInit {
  private readonly inspection: CoreInspectionStore;
  private readonly runtime: CoreInspectionStore;
  private readonly target: CoreInspectionStore;
  private readonly pending = new Map<string, Pending>();
  private readonly shutdown = new AbortController();
  private readonly recovering = new Set<string>();
  private storageUnverified = true;
  private reconciliationRecoveryRequired = false;
  private startup?: Promise<void>;
  constructor(
    config: ConfigurationService,
    private readonly auth: AuthService,
    private readonly timeMachine: TimeMachineService,
  ) {
    const directory = config.get('directories').dataDir;
    this.inspection = new CoreInspectionStore(directory, 'core-bootstrap-inspections');
    this.runtime = new CoreInspectionStore(directory, 'core-runtime-enrollments');
    this.target = new CoreInspectionStore(directory, 'core-target-preparations');
    setCorePreparationRecoveryRequired(true);
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
    this.storageUnverified = true;
    this.recoveryHold();
    try {
      for (const [operation, store] of [
        ['runtime', this.runtime],
        ['inspection', this.inspection],
        ['target', this.target],
      ] as const) {
        for (const record of await store.recoveryRecords()) {
          if (!(await store.marked(record.requestId, record, 'requested'))) continue;
          const approval = operation === 'inspection' && (await store.marked(record.requestId, record, 'approval-requested'));
          if (await store.marked(record.requestId, record, approval ? 'approval-settled' : 'settled')) continue;
          this.recovering.add(`${operation}:${record.requestId}`);
          const records = await this.records(record.requestId, record);
          try {
            if (operation === 'runtime') {
              const runtime = await callCoreRestoreRuntimeRoot({
                id: records.runtime.id,
                actor: records.runtime.actor,
                signal: this.shutdown.signal,
                action: 'status',
              });
              await this.observed(records, operation, runtime.phase === 'installed' || runtime.phase === 'not-supported');
            } else if (operation === 'inspection') {
              const inspection = await callCoreBootstrapInspectionRoot({ ...this.sourceOptions(records), action: 'status' });
              await this.observed(records, operation, this.sourceSettled(inspection));
            } else {
              const target = await callCoreCleanTargetPreparationRoot({ ...this.targetOptions(records), action: 'status' });
              await this.observed(records, operation, target.preparedTargetAvailable);
            }
          } catch {
            /* Unknown Root ownership remains held; startup never replays work. */
          }
        }
      }
      this.storageUnverified = false;
    } catch {
      /* Invalid recovery records must keep mutation admission closed. */
    }
    this.recoveryHold();
  }
  private recoveryHold() {
    setCorePreparationRecoveryRequired(this.storageUnverified || this.recovering.size > 0 || this.reconciliationRecoveryRequired);
  }
  setReconciliationRecoveryRequired(required: boolean) {
    this.reconciliationRecoveryRequired = required;
    this.recoveryHold();
  }
  private async actor(request: Request, ownerId: number) {
    const actor = await this.auth.operatorActionContext(request);
    if (actor.userId !== ownerId) throw fail();
    return actor;
  }
  private async binding(pointId: string, ownerId: number, actor: Actor, request: Request): Promise<CoreInspectionBinding> {
    if (!timeMachineIdSchema.allows(pointId)) throw fail();
    const point = await this.timeMachine.coreInspectionBindingPoint(pointId, ownerId, request);
    if (point.pointId !== pointId || point.ownerId !== ownerId) throw fail();
    return { ...point, actor: { ownerId, sessionBinding: actor.sessionBinding, securityBinding: actor.securityBinding } };
  }
  private async records(requestId: string, binding: CoreInspectionBinding, reserve = false): Promise<Records> {
    try {
      const [inspection, runtime, target] = await Promise.all(
        [this.inspection, this.runtime, this.target].map((store) => (reserve ? store.reserve(requestId, binding) : store.get(requestId, binding))),
      );
      if (!inspection || !runtime || !target || [inspection, runtime, target].some((record) => record.version !== 2)) throw fail();
      if (new Set([inspection.id, runtime.id, target.id, requestId, binding.pointId]).size !== 5) throw fail();
      return { inspection, runtime, target };
    } catch {
      throw fail();
    }
  }
  private async current(request: Request, actor: Actor, record: CoreInspectionRecord) {
    if (!sameActor(actor, await this.actor(request, record.ownerId))) throw fail();
    const binding = await this.binding(record.pointId, record.ownerId, actor, request);
    if (binding.archiveSha256 !== record.archiveSha256 || binding.manifestSha256 !== record.manifestSha256) throw fail();
  }
  private backgroundRequest(request: Request): Request {
    // Retain the session needed for revalidation, never the submitted password/body.
    return {
      authMethod: request.authMethod,
      user: request.user ? { id: request.user.id, operator: request.user.operator } : undefined,
      cookies: { [SESSION_COOKIE_NAME]: request.cookies?.[SESSION_COOKIE_NAME] },
    } as unknown as Request;
  }
  private wrapper(records: Records, state: string, progress: Progress = {}) {
    return {
      schema: 'orbis.core-restore-preparation-operation.v1' as const,
      requestId: records.inspection.requestId,
      id: records.inspection.id,
      pointId: records.inspection.pointId,
      ownerId: records.inspection.ownerId,
      state,
      restoreSupported: false as const,
      activationAuthorized: false as const,
      preparedTargetAvailable: progress.preparation?.preparedTargetAvailable === true,
      ...progress,
    };
  }
  private stage(requestId: string, state: Stage) {
    const pending = this.pending.get(requestId);
    if (!pending || this.shutdown.signal.aborted) throw fail();
    pending.state = state;
  }
  private launch(records: Records, state: Stage, work: () => Promise<void>) {
    const requestId = records.inspection.requestId;
    if (this.shutdown.signal.aborted || this.pending.has(requestId)) throw fail();
    const mutation = enterBackupMutation();
    if (!mutation) throw fail();
    let disk: () => void;
    try {
      disk = acquireBackupDisk();
    } catch (error) {
      mutation();
      throw error;
    }
    const pending: Pending = {
      state,
      done: Promise.resolve(),
      uncertain: false,
      finished: false,
      release: () => {
        disk();
        mutation();
        if (this.pending.get(requestId) === pending) this.pending.delete(requestId);
      },
    };
    pending.done = Promise.resolve()
      .then(work)
      .catch(() => {
        pending.state = 'recovery-required';
      })
      .finally(() => {
        pending.finished = true;
        // Disconnecting never proves the independent Root worker has stopped.
        if (!pending.uncertain) pending.release();
      });
    this.pending.set(requestId, pending);
    return this.wrapper(records, state);
  }
  private dispatched(records: Records, operation: Operation) {
    const pending = this.pending.get(records.inspection.requestId);
    if (!pending) throw fail();
    pending.uncertain = true;
    pending.operation = operation;
  }
  private async observed(records: Records, operation: Operation, settled: boolean) {
    const pending = this.pending.get(records.inspection.requestId);
    if (!pending && !this.recovering.has(`${operation}:${records.inspection.requestId}`)) return;
    if (!settled || (pending && pending.operation !== operation)) return;
    const store = operation === 'runtime' ? this.runtime : operation === 'inspection' ? this.inspection : this.target;
    const binding = records.inspection;
    const approval = operation === 'inspection' && (await store.marked(binding.requestId, binding, 'approval-requested'));
    await store.mark(binding.requestId, binding, approval ? 'approval-settled' : 'settled');
    this.recovering.delete(`${operation}:${binding.requestId}`);
    this.recoveryHold();
    if (pending) {
      pending.uncertain = false;
      if (pending.finished) pending.release();
    }
  }
  private sourceSettled(status: CoreBootstrapInspectionStatus) {
    return ['awaiting-approval', 'expired', 'inspection-complete'].includes(status.phase);
  }
  private sourceOptions(records: Records) {
    const record = records.inspection;
    return { id: record.id, pointId: record.pointId, manifestSha256: record.manifestSha256, actor: record.actor, signal: this.shutdown.signal };
  }
  private targetOptions(records: Records) {
    return { id: records.target.id, sourceInspectionId: records.inspection.id, actor: records.target.actor, signal: this.shutdown.signal };
  }
  async prepare(pointId: string, ownerId: number, request: Request, requestId: string) {
    const actor = await this.actor(request, ownerId);
    const binding = await this.binding(pointId, ownerId, actor, request);
    const records = await this.records(requestId, binding, true);
    await this.current(request, actor, records.inspection);
    const pending = this.pending.get(requestId);
    if (pending) return this.wrapper(records, pending.state);
    if (await this.runtime.marked(requestId, binding, 'requested')) return this.status(pointId, ownerId, request, requestId);
    const background = this.backgroundRequest(request);
    return this.launch(records, 'checking-support', async () => {
      await this.current(background, actor, records.inspection);
      if (await this.runtime.marked(requestId, binding, 'requested')) return;
      await this.runtime.mark(requestId, binding, 'requested');
      const options = { id: records.runtime.id, actor: records.runtime.actor, signal: this.shutdown.signal };
      this.dispatched(records, 'runtime');
      let runtime = await callCoreRestoreRuntimeRoot({ ...options, action: 'prepare' });
      while (runtime.enrollmentActive) {
        runtime = await callCoreRestoreRuntimeRoot({ ...options, action: 'wait' });
      }
      await this.observed(records, 'runtime', runtime.phase === 'installed' || runtime.phase === 'not-supported');
      await this.current(background, actor, records.inspection);
      if (!runtime.runtimeAvailable) return;
      this.stage(requestId, 'preparing');
      await this.inspection.mark(requestId, binding, 'requested');
      this.dispatched(records, 'inspection');
      const inspection = await callCoreBootstrapInspectionRoot({ ...this.sourceOptions(records), action: 'prepare' });
      await this.observed(records, 'inspection', this.sourceSettled(inspection));
      await this.current(background, actor, records.inspection);
    });
  }
  async status(pointId: string, ownerId: number, request: Request, requestId: string) {
    const actor = await this.actor(request, ownerId);
    const binding = await this.binding(pointId, ownerId, actor, request);
    const records = await this.records(requestId, binding);
    await this.current(request, actor, records.inspection);
    const pending = this.pending.get(requestId);
    let state: string = pending?.state ?? 'recovery-required';
    let progress: Progress = {};
    try {
      if (await this.target.marked(requestId, binding, 'requested')) {
        const preparation = await callCoreCleanTargetPreparationRoot({ ...this.targetOptions(records), action: 'status' });
        state = preparation.phase;
        progress = { preparation };
        if (this.pending.get(requestId) === pending && (!pending || pending.finished))
          await this.observed(records, 'target', preparation.preparedTargetAvailable);
      } else if (await this.inspection.marked(requestId, binding, 'requested')) {
        const inspection = await callCoreBootstrapInspectionRoot({ ...this.sourceOptions(records), action: 'status' });
        state = inspection.phase;
        progress = { inspection };
        if (this.pending.get(requestId) === pending && (!pending || pending.finished))
          await this.observed(records, 'inspection', this.sourceSettled(inspection));
      } else if (await this.runtime.marked(requestId, binding, 'requested')) {
        const runtime = await callCoreRestoreRuntimeRoot({
          id: records.runtime.id,
          actor: records.runtime.actor,
          signal: this.shutdown.signal,
          action: 'status',
        });
        state = runtime.runtimeAvailable ? 'ready-to-inspect' : runtime.phase;
        progress = { runtime };
        if (this.pending.get(requestId) === pending && (!pending || pending.finished))
          await this.observed(records, 'runtime', runtime.phase === 'installed' || runtime.phase === 'not-supported');
      } else {
        state = pending?.state ?? 'not-started';
      }
    } catch {
      state = pending?.state ?? 'recovery-required';
    }
    await this.current(request, actor, records.inspection);
    return this.wrapper(records, state, progress);
  }
  async approve(
    pointId: string,
    ownerId: number,
    request: Request,
    requestId: string,
    credentials: { password: string; totpCode?: string },
    input: CoreBootstrapInspectionApproval,
  ) {
    const actor = await this.actor(request, ownerId);
    const binding = await this.binding(pointId, ownerId, actor, request);
    const records = await this.records(requestId, binding);
    if (this.pending.has(requestId) || !(await this.inspection.marked(requestId, binding, 'requested'))) throw fail();
    if (await this.inspection.marked(requestId, binding, 'approval-requested')) return this.status(pointId, ownerId, request, requestId);
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    await this.current(request, actor, records.inspection);
    const inspection = await callCoreBootstrapInspectionRoot({ ...this.sourceOptions(records), action: 'status' });
    await this.current(request, actor, records.inspection);
    if (inspection.phase !== 'awaiting-approval') return this.wrapper(records, inspection.phase, { inspection });
    const background = this.backgroundRequest(request);
    const approval = structuredClone(input);
    return this.launch(records, 'authorizing', async () => {
      await this.current(background, actor, records.inspection);
      if (await this.inspection.marked(requestId, binding, 'approval-requested')) return;
      await this.inspection.mark(requestId, binding, 'approval-requested');
      this.dispatched(records, 'inspection');
      const result = await callCoreBootstrapInspectionRoot({ ...this.sourceOptions(records), action: 'approve', input: approval });
      await this.observed(records, 'inspection', this.sourceSettled(result));
      await this.current(background, actor, records.inspection);
    });
  }
  async prepareTarget(pointId: string, ownerId: number, request: Request, requestId: string, action: 'prepare-isolated-clean-target') {
    if (action !== 'prepare-isolated-clean-target') throw fail();
    const actor = await this.actor(request, ownerId);
    const binding = await this.binding(pointId, ownerId, actor, request);
    const records = await this.records(requestId, binding);
    if (this.pending.has(requestId) || !(await this.inspection.marked(requestId, binding, 'requested'))) throw fail();
    if (await this.target.marked(requestId, binding, 'requested')) return this.status(pointId, ownerId, request, requestId);
    const inspection = await callCoreBootstrapInspectionRoot({ ...this.sourceOptions(records), action: 'status' });
    await this.current(request, actor, records.inspection);
    if (inspection.phase !== 'inspection-complete' || !inspection.bootstrapCatalogAvailable) throw fail();
    const background = this.backgroundRequest(request);
    return this.launch(records, 'preparing-target', async () => {
      await this.current(background, actor, records.inspection);
      if (await this.target.marked(requestId, binding, 'requested')) return;
      await this.target.mark(requestId, binding, 'requested');
      const options = this.targetOptions(records);
      this.dispatched(records, 'target');
      let target = await callCoreCleanTargetPreparationRoot({ ...options, action: 'prepare' });
      while (target.preparationActive) {
        target = await callCoreCleanTargetPreparationRoot({ ...options, action: 'wait' });
      }
      await this.observed(records, 'target', target.preparedTargetAvailable);
      await this.current(background, actor, records.inspection);
    });
  }
  async onModuleDestroy() {
    this.shutdown.abort();
    await Promise.allSettled([...this.pending.values()].map((pending) => pending.done));
  }
}
