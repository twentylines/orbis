import { ConflictException, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Request } from 'express';
import { ConfigurationService } from '@/core/config/configuration.service';
import { enterBackupMutation } from '@/common/backup-maintenance';
import { acquireBackupDisk } from '@/common/backup-disk';
import { AuthService } from '../auth/auth.service';
import { TimeMachineService } from './time-machine.service';
import { CoreInspectionStore, type CoreInspectionBinding, type CoreInspectionRecord } from './time-machine-core-inspection.store';
import {
  callCoreLocalInspectionRoot,
  type CoreLocalInspectionApproval,
  type CoreLocalInspectionStatus,
} from './time-machine-core-local-inspection-client';

const fail = () => new ConflictException('Local inspection requires protected recovery. Existing data was preserved.');
type Context = Awaited<ReturnType<AuthService['operatorActionContext']>>;
const sameActor = (a: Context, b: Context) =>
  a.userId === b.userId && a.sessionBinding === b.sessionBinding && a.securityBinding === b.securityBinding;
type Pending = { state: 'preparing' | 'authorizing'; done: Promise<void> };

@Injectable()
export class TimeMachineCoreInspectionService implements OnModuleDestroy {
  private readonly store: CoreInspectionStore;
  private readonly pending = new Map<string, Pending>();
  private readonly failures = new Set<string>();
  private readonly shutdown = new AbortController();
  constructor(
    config: ConfigurationService,
    private readonly auth: AuthService,
    private readonly timeMachine: TimeMachineService,
  ) {
    this.store = new CoreInspectionStore(config.get('directories').dataDir);
  }
  private async actor(request: Request, ownerId: number) {
    const actor = await this.auth.operatorActionContext(request);
    if (actor.userId !== ownerId) throw fail();
    return actor;
  }
  private async binding(pointId: string, ownerId: number, actor: Context, request: Request): Promise<CoreInspectionBinding> {
    const point = await this.timeMachine.coreInspectionBindingPoint(pointId, ownerId, request);
    if (point.pointId !== pointId || point.ownerId !== ownerId) throw fail();
    return { ...point, actor: { ownerId, sessionBinding: actor.sessionBinding, securityBinding: actor.securityBinding } };
  }
  private wrapper(record: CoreInspectionRecord, state: Pending['state'] | CoreLocalInspectionStatus['phase'], status?: CoreLocalInspectionStatus) {
    return {
      schema: 'orbis.core-local-inspection-operation.v1' as const,
      requestId: record.requestId,
      id: record.id,
      pointId: record.pointId,
      ownerId: record.ownerId,
      state,
      restoreSupported: false as const,
      activationAuthorized: false as const,
      ...(status ? { status } : {}),
    };
  }
  private async current(request: Request, actor: Context, record: CoreInspectionRecord) {
    if (!sameActor(actor, await this.actor(request, record.ownerId))) throw fail();
    const binding = await this.binding(record.pointId, record.ownerId, actor, request);
    if (binding.archiveSha256 !== record.archiveSha256 || binding.manifestSha256 !== record.manifestSha256) throw fail();
  }
  private launch(action: 'prepare' | 'approve', request: Request, actor: Context, record: CoreInspectionRecord, input?: CoreLocalInspectionApproval) {
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
    const state = action === 'prepare' ? 'preparing' : 'authorizing';
    const work = async () => {
      try {
        await this.current(request, actor, record);
        await callCoreLocalInspectionRoot({
          action,
          id: record.id,
          pointId: record.pointId,
          manifestSha256: record.manifestSha256,
          actor: record.actor,
          signal: this.shutdown.signal,
          ...(input ? { input } : {}),
        });
        await this.current(request, actor, record);
        this.failures.delete(record.requestId);
      } catch {
        this.failures.add(record.requestId);
      } finally {
        disk();
        mutation();
        this.pending.delete(record.requestId);
      }
    };
    const done = work();
    this.pending.set(record.requestId, { state, done });
    return this.wrapper(record, state);
  }
  async prepare(pointId: string, ownerId: number, request: Request, requestId: string) {
    const actor = await this.actor(request, ownerId);
    const binding = await this.binding(pointId, ownerId, actor, request);
    await this.current(request, actor, { ...binding, requestId, id: '', version: 1 });
    const record = await this.store.reserve(requestId, binding);
    const pending = this.pending.get(requestId);
    if (pending) return this.wrapper(record, pending.state);
    return this.launch('prepare', request, actor, record);
  }
  async status(pointId: string, ownerId: number, request: Request, requestId: string) {
    const actor = await this.actor(request, ownerId);
    const binding = await this.binding(pointId, ownerId, actor, request);
    const record = await this.store.get(requestId, binding);
    if (!record) throw fail();
    await this.current(request, actor, record);
    const pending = this.pending.get(requestId);
    if (pending) return this.wrapper(record, pending.state);
    let status: CoreLocalInspectionStatus;
    try {
      status = await callCoreLocalInspectionRoot({
        action: 'status',
        id: record.id,
        pointId,
        manifestSha256: record.manifestSha256,
        actor: record.actor,
        signal: this.shutdown.signal,
      });
    } catch {
      await this.current(request, actor, record);
      this.failures.add(requestId);
      return this.wrapper(record, 'recovery-required');
    }
    await this.current(request, actor, record);
    this.failures.delete(requestId);
    return this.wrapper(record, status.phase, status);
  }
  async approve(
    pointId: string,
    ownerId: number,
    request: Request,
    requestId: string,
    credentials: { password: string; totpCode?: string },
    input: CoreLocalInspectionApproval,
  ) {
    const actor = await this.actor(request, ownerId);
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    if (!sameActor(actor, await this.actor(request, ownerId))) throw fail();
    const binding = await this.binding(pointId, ownerId, actor, request);
    const record = await this.store.get(requestId, binding);
    if (!record || this.pending.has(requestId) || this.failures.has(requestId)) throw fail();
    await this.current(request, actor, record);
    return this.launch('approve', request, actor, record, input);
  }
  async onModuleDestroy() {
    this.shutdown.abort();
    await Promise.allSettled([...this.pending.values()].map((item) => item.done));
  }
}
