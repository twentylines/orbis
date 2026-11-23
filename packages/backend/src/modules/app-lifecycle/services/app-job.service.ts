import { ConflictException, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { coreCaptureRecoveryRequired } from '@/common/backup-maintenance';
import { installationHeld } from '@/common/installation-mode';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { TasksService } from '@/modules/tasks/tasks.service';
import type { AppJob } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import type { AppEvent, appEventResultSchema } from '@/modules/queue/entities/app-events';
import { AppJobStore, jobInputHash, jobStoreError, type AppJobRecord } from './app-job.store';
import type { TaskPhase } from '@runtipi/common/schemas/task-history';

export type JobEvent = AppEvent & { command: 'backup' | 'update' };
type Result = typeof appEventResultSchema.infer;
export type AppJobContext = {
  signal: AbortSignal;
  check: () => void;
  seal: () => Promise<void>;
  recover: () => Promise<void>;
  progress: (phase: TaskPhase) => Promise<void>;
};
type LiveJob = { context: AppJobContext; controller: AbortController; cancellable: boolean; done: Promise<void>; resolve: () => void };
const interrupted = (): Result => ({ success: false, message: 'This operation was interrupted. Review recovery before retrying.' });

@Injectable()
export class AppJobService implements OnModuleDestroy, OnModuleInit {
  private readonly live = new Map<string, LiveJob>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private closing = false;

  constructor(
    private readonly config: ConfigurationService,
    private readonly apps: AppsRepository,
    private readonly tasks: TasksService,
  ) {}

  private store() {
    return new AppJobStore(this.config.get('directories').dataDir);
  }

  async onModuleInit() {
    if (coreCaptureRecoveryRequired() || installationHeld()) return;
    for (const task of (await this.tasks.read()).tasks) {
      if (task.cancellable === undefined || !['backup', 'update'].includes(task.action) || task.status !== 'interrupted' || task.startedAt !== null)
        continue;
      try {
        const record = await this.store().read(task.id);
        if (!record || record.state !== 'queued' || record.appUrn !== task.appUrn || record.command !== task.action || record.startedAt !== null)
          continue;
        await this.identity(record, true);
        await this.tasks.requeue(task);
      } catch {
        // Display history cannot substitute for an admitted operation record.
      }
    }
  }
  private async serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const before = this.writes.get(id) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(work);
    this.writes.set(id, next);
    try {
      return await next;
    } finally {
      if (this.writes.get(id) === next) this.writes.delete(id);
    }
  }
  private async identity(record: AppJobRecord, preparing = false) {
    if ((await this.store().current(record.appUrn))?.requestId !== record.requestId) throw jobStoreError();
    const current = await this.apps.getAppByUrn(record.appUrn);
    if (
      !current ||
      current.id !== record.appId ||
      current.createdAt !== record.appCreatedAt ||
      `${current.appName}:${current.appStoreSlug}` !== record.appUrn ||
      (preparing && (current.version !== record.appVersion || current.status !== (record.command === 'backup' ? 'backing_up' : 'updating')))
    )
      throw jobStoreError();
    return current;
  }
  private binding(record: AppJobRecord, event: JobEvent) {
    if (
      event.jobVersion !== 1 ||
      record.requestId !== event.requestId ||
      record.appUrn !== event.appUrn ||
      record.command !== event.command ||
      record.inputSha256 !== jobInputHash(event.form, event.command === 'update' ? event.performBackup : undefined)
    )
      throw jobStoreError();
  }

  async admit(event: JobEvent, app: Awaited<ReturnType<AppsRepository['getAppByUrn']>>) {
    if (this.closing || event.jobVersion !== 1 || !app || !['running', 'stopped'].includes(app.status))
      throw new ConflictException('Wait for the current app operation to finish.');
    const now = Date.now();
    const record: AppJobRecord = {
      version: 1,
      requestId: event.requestId,
      appUrn: event.appUrn,
      command: event.command,
      appId: app.id,
      appCreatedAt: app.createdAt,
      appVersion: app.version,
      previousStatus: app.status as 'running' | 'stopped',
      inputSha256: jobInputHash(event.form, event.command === 'update' ? event.performBackup : undefined),
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      cancelRequestedAt: null,
    };
    if (`${app.appName}:${app.appStoreSlug}` !== event.appUrn) throw jobStoreError();
    await this.serial(`app:${event.appUrn}`, async () => {
      const row = await this.apps.getAppByUrn(event.appUrn);
      if (!row || row.id !== app.id || row.createdAt !== app.createdAt || row.version !== app.version || !['running', 'stopped'].includes(row.status))
        throw jobStoreError();
      const current = await this.store().current(event.appUrn);
      if (current) {
        const previous = await this.store().read(current.requestId);
        if (!previous || !['succeeded', 'failed', 'cancelled'].includes(previous.state))
          throw new ConflictException('This app already has an unfinished operation. Review it before starting another.');
      }
      await this.store().write(record);
      await this.store().write(record, current ?? undefined, true);
    });
    await this.tasks.enqueue(event);
    await this.tasks.setCancellable(event, true);
  }

  async abandon(event: JobEvent) {
    await this.serial(event.requestId, async () => {
      const record = await this.store().read(event.requestId);
      if (!record) throw jobStoreError();
      this.binding(record, event);
      if (record.startedAt !== null) throw jobStoreError();
      await this.store().write({ ...record, state: 'failed', updatedAt: Date.now() }, record);
      await this.tasks.finish(event, false);
    });
  }

  async begin(event: JobEvent, resuming: boolean): Promise<{ context?: AppJobContext; result?: Result; fresh?: boolean }> {
    return this.serial(event.requestId, async () => {
      if (this.closing || this.live.has(event.requestId)) throw new ConflictException('The operation already has a worker.');
      let record = await this.store().read(event.requestId);
      if (!record) throw jobStoreError();
      this.binding(record, event);
      await this.identity(record, record.state === 'queued' || (record.state === 'cancel-requested' && record.startedAt === null));
      if (record.state === 'cancelled') return { result: { success: false, cancelled: true, statePreserved: true, message: 'Operation cancelled.' } };
      if (record.cancelRequestedAt !== null && record.startedAt !== null) return { result: interrupted() };
      if (record.state === 'cancel-requested') {
        if (record.startedAt !== null) return { result: interrupted() };
        await this.store().write({ ...record, state: 'cancelled', updatedAt: Date.now() }, record);
        await this.tasks.cancelled(event);
        return {
          result: {
            success: false,
            cancelled: true,
            statePreserved: true,
            updateStatus: record.previousStatus,
            message: 'Operation cancelled before it started.',
          },
        };
      }
      if (record.state === 'failed' || (record.state === 'interrupted' && event.command !== 'update')) return { result: interrupted() };
      if (record.startedAt !== null && event.command === 'backup') return { result: interrupted() };
      if (record.state === 'succeeded') {
        if (!resuming) return { result: { success: true, alreadyCompleted: true, message: 'Operation already completed.' } };
      } else if (record.state !== 'queued' && !resuming) throw jobStoreError();
      // Recovery of an already issued update uses its existing durable stage. It never becomes newly cancellable.
      const cancellable = record.state === 'queued';
      const controller = new AbortController();
      let resolve!: () => void;
      const done = new Promise<void>((complete) => {
        resolve = complete;
      });
      const check = () => {
        if (this.live.get(event.requestId)?.context !== context) throw jobStoreError();
        controller.signal.throwIfAborted();
      };
      const context: AppJobContext = {
        signal: controller.signal,
        check,
        progress: (phase) => this.tasks.progress(event, phase),
        recover: () =>
          this.serial(event.requestId, async () => {
            const current = await this.store().read(event.requestId);
            if (!current || this.live.get(event.requestId) !== entry) throw jobStoreError();
            this.binding(current, event);
            if (current.state === 'running') await this.store().write({ ...current, state: 'sealed', updatedAt: Date.now() }, current);
            entry.cancellable = false;
            await this.tasks.setCancellable(event, false);
          }),
        seal: () =>
          this.serial(event.requestId, async () => {
            check();
            const current = await this.store().read(event.requestId);
            if (!current) throw jobStoreError();
            this.binding(current, event);
            await this.identity(current);
            if (!['running', 'sealed', 'succeeded'].includes(current.state)) throw jobStoreError();
            if (current.state === 'running') await this.store().write({ ...current, state: 'sealed', updatedAt: Date.now() }, current);
            entry.cancellable = false;
            await this.tasks.setCancellable(event, false);
          }),
      };
      const entry: LiveJob = { controller, context, cancellable, done, resolve };
      if (record.state === 'queued') {
        const next = { ...record, state: 'running' as const, startedAt: Date.now(), updatedAt: Date.now() };
        await this.store().write(next, record);
        record = next;
      }
      this.live.set(event.requestId, entry);
      await this.tasks.setCancellable(event, cancellable);
      return { context, fresh: cancellable };
    });
  }

  async finish(event: JobEvent, context: AppJobContext, response: Result): Promise<Result> {
    let result = response;
    return this.serial(event.requestId, async () => {
      const entry = this.live.get(event.requestId);
      if (!entry || entry.context !== context) throw jobStoreError();
      try {
        const record = await this.store().read(event.requestId);
        if (!record) throw jobStoreError();
        this.binding(record, event);
        await this.identity(record);
        if (context.signal.aborted && result.success) result = interrupted();
        const cancelled = context.signal.aborted && !result.success && result.statePreserved === true;
        const state = result.success ? 'succeeded' : cancelled ? 'cancelled' : result.statePreserved === true ? 'failed' : 'interrupted';
        await this.store().write({ ...record, state, updatedAt: Date.now() }, record);
        if (cancelled) await this.tasks.cancelled(event);
        else if (state === 'interrupted') await this.tasks.interrupt(event);
        else await this.tasks.finish(event, result.success);
        return cancelled ? { ...result, cancelled: true, message: 'Operation cancelled. The previous app state was preserved.' } : result;
      } finally {
        this.live.delete(event.requestId);
        entry.resolve();
        await this.tasks.setCancellable(event, false);
      }
    });
  }

  async cancel(appUrn: AppUrn, requestId: string, shutdown = false) {
    await this.serial(requestId, async () => {
      const record = await this.store().read(requestId);
      if (!record || record.appUrn !== appUrn) throw new ConflictException('This operation is no longer available.');
      await this.identity(record, record.state === 'queued');
      const entry = this.live.get(requestId);
      if (
        (this.closing && !shutdown) ||
        !['queued', 'running', 'cancel-requested'].includes(record.state) ||
        (record.startedAt !== null && !entry?.cancellable)
      )
        throw new ConflictException('This operation cannot be cancelled while deployment or recovery is in progress.');
      if (record.state !== 'cancel-requested')
        await this.store().write({ ...record, state: 'cancel-requested', updatedAt: Date.now(), cancelRequestedAt: Date.now() }, record);
      entry?.controller.abort(new Error('Operation cancelled.'));
      await this.tasks.cancelling({ requestId, appUrn, command: record.command });
    });
    return this.getJob(appUrn, requestId);
  }

  async withCurrent(event: JobEvent, apply: () => Promise<void>) {
    return this.serial(`app:${event.appUrn}`, async () => {
      const record = await this.store().read(event.requestId);
      if (!record) return false;
      this.binding(record, event);
      try {
        await this.identity(record);
      } catch {
        return false;
      }
      await apply();
      return true;
    });
  }

  async hasUnsettledJob(appUrn: AppUrn): Promise<boolean> {
    const current = await this.store().current(appUrn);
    if (!current) return false;
    const record = await this.store().read(current.requestId);
    if (!record || record.appUrn !== appUrn || record.command !== current.command) throw jobStoreError();
    return !['succeeded', 'failed', 'cancelled'].includes(record.state);
  }

  async getJob(appUrn: AppUrn, requestId?: string): Promise<{ job: AppJob | null }> {
    const history = await this.tasks.read();
    const task = history.tasks.find(
      (value) => value.appUrn === appUrn && ['backup', 'update'].includes(value.action) && (!requestId || value.id === requestId),
    );
    if (!task) return { job: null };
    const record = await this.store().read(task.id);
    if (record && (record.appUrn !== appUrn || record.command !== task.action)) throw jobStoreError();
    const entry = this.live.get(task.id);
    const eligible = !!record && (record.state === 'queued' || (record.state === 'running' && !!entry?.cancellable));
    const cancellable =
      eligible &&
      !!record &&
      (await this.identity(record, record.state === 'queued').then(
        () => true,
        () => false,
      ));
    return {
      job: {
        requestId: task.id,
        appUrn,
        command: task.action as 'backup' | 'update',
        status: task.status,
        ...(task.phase ? { phase: task.phase } : {}),
        cancellable,
        startedAt: Date.parse(task.startedAt ?? task.createdAt),
        updatedAt: Date.parse(task.updatedAt),
        message: '',
      },
    };
  }

  async onModuleDestroy() {
    this.closing = true;
    const active = [...this.live.entries()];
    for (const [id, entry] of active) {
      if (!entry.cancellable) continue;
      const record = await this.store().read(id);
      if (record) await this.cancel(record.appUrn, id, true).catch(() => undefined);
    }
    await Promise.all(active.map(([, entry]) => entry.done));
  }
}
