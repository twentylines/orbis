import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException, type OnModuleInit } from '@nestjs/common';
import { taskRecordSchema, type TaskAction, type TaskHistory, type TaskRecord } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import { type } from 'arktype';
import { taskAttentionKey, taskAttentionLedgerSchema } from '@runtipi/common/schemas/task-history';
import { installationHeld } from '@/common/installation-mode';

type TaskEvent = { requestId: string; appUrn: AppUrn; command: TaskAction; displayName?: string };
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
  private readonly attentionWrites = new Map<number, Promise<unknown>>();

  constructor(
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
  ) {}

  async onModuleInit() {
    if (installationHeld()) return;
    await this.load();
  }

  private transition(task: TaskRecord, status: TaskRecord['status']) {
    if (task.status !== status && ['failed', 'interrupted', 'unconfirmed'].includes(status)) {
      if (task.attentionRevision === 2147483647) throw new Error('Task attention revision limit reached');
      task.attentionRevision = (task.attentionRevision ?? 0) + 1;
    }
    task.status = status;
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
      this.tasks = parsed.map((task) => {
        if (active.has(task.status)) {
          this.transition(task, 'interrupted');
          task.updatedAt = now;
        }
        return task;
      });
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
            ...(event.displayName ? { displayName: event.displayName } : {}),
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
      this.transition(task, 'running');
      task.startedAt = new Date().toISOString();
      task.updatedAt = task.startedAt;
      task.finishedAt = null;
    });
  }

  finish(event: TaskEvent, success: boolean) {
    return this.change(event, (task) => {
      this.transition(task, success ? 'succeeded' : 'failed');
      task.finishedAt = new Date().toISOString();
      task.updatedAt = task.finishedAt;
    });
  }

  unconfirmed(event: TaskEvent) {
    return this.change(event, (task) => {
      if (!active.has(task.status)) return;
      this.transition(task, 'unconfirmed');
      task.updatedAt = new Date().toISOString();
    });
  }

  interrupt(event: TaskEvent) {
    return this.change(event, (task) => {
      if (!active.has(task.status)) return;
      this.transition(task, 'interrupted');
      task.updatedAt = new Date().toISOString();
    });
  }

  private attentionFile(userId: number) {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new BadRequestException('Invalid task account.');
    return path.join(this.config.get('directories').dataDir, 'state', 'orbis-tasks', 'attention', `${userId}.json`);
  }

  private async storedAttention(userId: number): Promise<string[]> {
    try {
      const handle = await fs.open(this.attentionFile(userId), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 256 * 1024 || info.mode & 0o077 || (process.getuid && info.uid !== process.getuid()))
          throw new Error();
        const parsed = taskAttentionLedgerSchema(JSON.parse(await handle.readFile('utf8')));
        if (parsed instanceof type.errors) throw new Error();
        return parsed.keys;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new ServiceUnavailableException('Task acknowledgements could not be read. Existing records were preserved.');
    }
  }

  async readAttention(userId: number) {
    await this.attentionWrites.get(userId);
    return { version: 1 as const, keys: await this.storedAttention(userId) };
  }

  async acknowledgeAttention(userId: number, body: unknown) {
    const parsed = taskAttentionLedgerSchema(body);
    if (parsed instanceof type.errors || parsed.keys.length > limit) throw new BadRequestException('Choose up to 300 observed task alerts.');
    this.attentionFile(userId);
    if (parsed.keys.length === 0) return this.readAttention(userId);
    const operation = async () => {
      const history = await this.read();
      const current = new Set(history.tasks.map(taskAttentionKey).filter((key): key is string => Boolean(key)));
      if (parsed.keys.some((key) => !current.has(key))) throw new ConflictException('Tasks changed. Refresh task history before acknowledging them.');
      const previous = await this.storedAttention(userId);
      // Missing history is not proof of retirement; preserve older acknowledgements when records are backfilled.
      const keys = [...new Set([...previous, ...parsed.keys])];
      if (keys.length > 4096)
        throw new ServiceUnavailableException('Task acknowledgement storage is full. Existing acknowledgements were preserved.');
      const file = this.attentionFile(userId);
      const directory = path.dirname(file);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const parent = await fs.lstat(directory);
        if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077 || (process.getuid && parent.uid !== process.getuid()))
          throw new Error();
        const handle = await fs.open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify({ version: 1, keys })}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, file);
        const parentHandle = await fs.open(directory, fs.constants.O_RDONLY);
        try {
          await parentHandle.sync();
        } finally {
          await parentHandle.close();
        }
      } catch {
        throw new ServiceUnavailableException('Task acknowledgements could not be saved. Existing records were preserved.');
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
      return { version: 1 as const, keys };
    };
    const result = (this.attentionWrites.get(userId) ?? Promise.resolve()).then(operation, operation);
    this.attentionWrites.set(
      userId,
      result.catch(() => undefined),
    );
    return result;
  }

  async read(): Promise<TaskHistory> {
    await this.load();
    await this.writes;
    return { tasks: this.tasks.map((task) => ({ ...task })), storage: this.storage, sampledAt: new Date().toISOString(), retentionDays, limit };
  }
}
