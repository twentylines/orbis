import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { taskRecordSchema, type TaskAction, type TaskHistory, type TaskRecord } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import { type } from 'arktype';

type TaskEvent = { requestId: string; appUrn: AppUrn; command: TaskAction };
const limit = 300;
const retentionDays = 30;
const active = new Set<TaskRecord['status']>(['queued', 'running', 'unconfirmed']);
const storedHistory = taskRecordSchema.array().narrow((tasks) => tasks.length <= limit);

@Injectable()
export class TasksService implements OnModuleInit {
  private tasks: TaskRecord[] = [];
  private loading?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private storage: TaskHistory['storage'] = 'persistent';
  private unreadable = false;

  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  async onModuleInit() {
    await this.load();
  }

  private file() {
    return path.join(this.config.get('directories').dataDir, 'state', 'orbis-tasks', 'history.json');
  }

  private load() {
    this.loading ??= this.readStored();
    return this.loading;
  }

  private async readStored() {
    try {
      const file = this.file();
      if ((await fs.stat(file)).size > 512 * 1024) throw new Error('Task history exceeds the storage limit');
      const parsed = storedHistory(JSON.parse(await fs.readFile(file, 'utf8')));
      if (parsed instanceof type.errors) throw new Error('Task history is invalid');
      const now = new Date().toISOString();
      this.tasks = parsed.map((task) => (active.has(task.status) ? { ...task, status: 'interrupted', updatedAt: now } : task));
      this.prune();
      await this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.unreadable = true;
      this.storage = 'unavailable';
      this.logger.warn('Task history could not be loaded. Operations continue; new history is available in memory only.');
    }
  }

  private prune() {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    this.tasks = this.tasks
      .filter((task) => active.has(task.status) || Date.parse(task.updatedAt) >= cutoff)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, limit);
  }

  private async persist() {
    if (this.unreadable) return;
    const file = this.file();
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, `${JSON.stringify(this.tasks)}\n`, { mode: 0o600 });
      await fs.rename(temporary, file);
      this.storage = 'persistent';
    } catch {
      this.storage = 'unavailable';
      this.logger.warn('Task history could not be saved. Operations continue; current history is available in memory only.');
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async change(event: TaskEvent, update: (task: TaskRecord) => void) {
    await this.load();
    this.writes = this.writes
      .catch(() => undefined)
      .then(async () => {
        let task = this.tasks.find((item) => item.id === event.requestId);
        if (!task) {
          const now = new Date().toISOString();
          task = {
            id: event.requestId,
            appUrn: event.appUrn,
            action: event.command,
            status: 'queued',
            createdAt: now,
            updatedAt: now,
            startedAt: null,
            finishedAt: null,
          };
          this.tasks.unshift(task);
        }
        update(task);
        this.prune();
        await this.persist();
      })
      .catch(() => {
        this.storage = 'unavailable';
        this.logger.warn('Task history could not be updated; the application operation continues.');
      });
    await this.writes;
  }

  enqueue(event: TaskEvent) {
    return this.change(event, () => undefined);
  }

  start(event: TaskEvent) {
    return this.change(event, (task) => {
      task.status = 'running';
      task.startedAt = new Date().toISOString();
      task.updatedAt = task.startedAt;
      task.finishedAt = null;
    });
  }

  finish(event: TaskEvent, success: boolean) {
    return this.change(event, (task) => {
      task.status = success ? 'succeeded' : 'failed';
      task.finishedAt = new Date().toISOString();
      task.updatedAt = task.finishedAt;
    });
  }

  unconfirmed(event: TaskEvent) {
    return this.change(event, (task) => {
      if (!active.has(task.status)) return;
      task.status = 'unconfirmed';
      task.updatedAt = new Date().toISOString();
    });
  }

  async read(): Promise<TaskHistory> {
    await this.load();
    await this.writes;
    return { tasks: this.tasks.map((task) => ({ ...task })), storage: this.storage, sampledAt: new Date().toISOString(), retentionDays, limit };
  }
}
