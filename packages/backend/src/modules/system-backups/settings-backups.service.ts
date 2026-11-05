import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { ReadStream } from 'node:fs';
import { settingsBackupJobSchema, settingsBackupSelectionSchema, type SettingsBackupJob } from '@runtipi/common/schemas/settings-backup';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AuthService } from '../auth/auth.service';
import { privateBackupDirectory } from './backup-files';
import { SettingsBackupSourceService } from './settings-backup-source.service';

type Credentials = { password: string; totpCode?: string };
type Stored = SettingsBackupJob & { ownerId: number };
const storedSchema = settingsBackupJobSchema.merge({ ownerId: 'number.integer > 0' }).onDeepUndeclaredKey('reject');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = () => new ConflictException('The backup is not ready. Your saved backups and apps were kept.');
const matches = (a: Awaited<ReturnType<typeof fs.stat>>, b: Awaited<ReturnType<typeof fs.stat>>) =>
  (['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'] as const).every((key) => a[key] === b[key]);

@Injectable()
export class SettingsBackupsService {
  private readonly jobs = new Map<string, Stored>();
  private readonly downloads = new Map<string, Set<ReadStream>>();
  private readonly admissions = new Map<string, number>();
  private loaded?: Promise<void>;
  private active?: { id: string; abort: AbortController; done: Promise<void> };
  private reserved: string | null = null;
  private closing = false;
  constructor(
    private readonly config: ConfigurationService,
    private readonly auth: AuthService,
    private readonly source: SettingsBackupSourceService,
  ) {}

  private root() {
    return path.join(this.config.get('directories').dataDir, 'backups', 'settings-bundles');
  }
  private directory(id: string) {
    if (!uuid.test(id)) throw new NotFoundException('Backup not found.');
    return path.join(this.root(), id);
  }
  private public(job: Stored): SettingsBackupJob {
    const { ownerId: _owner, ...value } = structuredClone(job);
    return settingsBackupJobSchema.assert(value);
  }
  private async initialize() {
    this.loaded ??= this.load();
    await this.loaded;
  }
  private async load() {
    await privateBackupDirectory(this.root());
    for (const id of await fs.readdir(this.root())) {
      const directory = this.directory(id);
      await privateBackupDirectory(directory);
      const file = await fs.open(path.join(directory, 'job.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let job: Stored;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.uid !== process.getuid?.() || stat.size > 65_536) throw fail();
        job = storedSchema.assert(JSON.parse(await file.readFile('utf8'))) as Stored;
        if (job.id !== id || !Number.isSafeInteger(job.ownerId) || !matches(stat, await file.stat())) throw fail();
      } finally {
        await file.close();
      }
      if (job.status === 'running' || job.status === 'queued') {
        job.status = 'interrupted';
        await this.save(job);
      }
      this.jobs.set(id, job);
      if (this.jobs.size > 32) throw fail();
    }
  }
  private async save(job: Stored) {
    const value = storedSchema.assert(structuredClone(job));
    const directory = this.directory(value.id);
    await privateBackupDirectory(directory);
    const before = await fs.lstat(directory);
    const temporary = path.join(directory, `.job-${randomUUID()}`);
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await privateBackupDirectory(directory);
      const current = await fs.lstat(directory);
      if (current.dev !== before.dev || current.ino !== before.ino) throw fail();
      await fs.rename(temporary, path.join(directory, 'job.json'));
      const parent = await fs.open(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  private async verify(request: Request, ownerId: number, credentials: Credentials) {
    const before = await this.auth.operatorActionContext(request);
    if (before.userId !== ownerId) throw fail();
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    const after = await this.auth.operatorActionContext(request);
    if (before.userId !== after.userId || before.securityBinding !== after.securityBinding || before.sessionBinding !== after.sessionBinding)
      throw fail();
  }
  private async owned(id: string, ownerId: number) {
    this.directory(id);
    await this.initialize();
    const job = this.jobs.get(id);
    if (!job || job.ownerId !== ownerId) throw new NotFoundException('Backup not found.');
    return job;
  }
  async list(ownerId: number) {
    await this.initialize();
    return { version: 1 as const, jobs: [...this.jobs.values()].filter((job) => job.ownerId === ownerId).map((job) => this.public(job)) };
  }

  async create(ownerId: number, request: Request, credentials: Credentials, selection: unknown, passphrase?: string) {
    const contents = settingsBackupSelectionSchema.assert(structuredClone(selection));
    await this.verify(request, ownerId, credentials);
    const encryptionKey = passphrase === undefined ? credentials.password : passphrase;
    if (typeof encryptionKey !== 'string' || encryptionKey.length < 8 || !encryptionKey.trim() || encryptionKey.length > 1024)
      throw new ConflictException('Choose a separate backup passphrase of at least 8 characters.');
    await this.initialize();
    if (this.closing || this.active || this.reserved || this.jobs.size >= 32) throw fail();
    const job: Stored = {
      version: 1,
      id: randomUUID(),
      ownerId,
      createdAt: Date.now(),
      status: 'queued',
      stage: 'preparing',
      completedBytes: 0,
      totalBytes: null,
      bytes: 0,
      sha256: null,
      selection: contents,
    };
    this.reserved = job.id;
    try {
      await fs.mkdir(this.directory(job.id), { mode: 0o700 });
      await this.save(job);
      this.jobs.set(job.id, job);
    } catch (error) {
      this.reserved = null;
      throw error;
    }
    return {
      job: this.public(job),
      start: () => this.run(job, request, credentials, encryptionKey),
    };
  }
  private run(job: Stored, request: Request, credentials: Credentials, passphrase: string) {
    if (this.closing || this.active || this.reserved !== job.id || this.jobs.get(job.id) !== job) return;
    this.reserved = null;
    const abort = new AbortController();
    const active = { id: job.id, abort, done: Promise.resolve() };
    this.active = active;
    active.done = (async () => {
      let writes = Promise.resolve();
      try {
        job.status = 'running';
        await this.save(job);
        let lastSave = 0;
        const result = await this.source.write({
          ownerId: job.ownerId,
          request,
          credentials,
          selection: job.selection,
          passphrase,
          directory: this.directory(job.id),
          destination: path.join(this.directory(job.id), 'archive.orbis-settings'),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60 * 60_000)]),
          progress: (value) => {
            const changedStage = job.stage !== value.stage;
            Object.assign(job, value);
            if (changedStage || Date.now() - lastSave >= 500) {
              lastSave = Date.now();
              const snapshot = structuredClone(job);
              writes = writes.then(() => this.save(snapshot));
              void writes.catch(() => abort.abort());
            }
          },
        });
        await writes;
        const ready: Stored = {
          ...job,
          status: 'ready',
          stage: 'complete',
          completedBytes: result.bytes,
          totalBytes: result.bytes,
          bytes: result.bytes,
          sha256: result.sha256,
        };
        await this.save(ready);
        this.jobs.set(job.id, ready);
      } catch {
        await writes.catch(() => undefined);
        const failed: Stored = { ...job, status: abort.signal.aborted ? 'cancelled' : 'failed' };
        await this.save(failed).catch(() => undefined);
        this.jobs.set(job.id, failed);
      } finally {
        if (this.active === active) this.active = undefined;
      }
    })();
  }

  private async sessionContext(request: Request, ownerId: number) {
    const context = await this.auth.operatorActionContext(request);
    if (context.userId !== ownerId) throw fail();
    return context;
  }
  private async verifySession(request: Request, ownerId: number, before: Awaited<ReturnType<AuthService['operatorActionContext']>>) {
    const after = await this.sessionContext(request, ownerId);
    if (before.securityBinding !== after.securityBinding || before.sessionBinding !== after.sessionBinding) throw fail();
  }
  private async ready(id: string, ownerId: number) {
    const job = await this.owned(id, ownerId);
    if (job.status !== 'ready' || !job.sha256 || this.closing) throw fail();
    return job;
  }
  async downloadInfo(id: string, ownerId: number, request: Request) {
    const before = await this.sessionContext(request, ownerId);
    const job = await this.ready(id, ownerId);
    await this.verifySession(request, ownerId, before);
    if ((await this.ready(id, ownerId)) !== job) throw fail();
    return {
      version: 1 as const,
      href: `/api/system-backups/settings-bundles/${id}/download`,
      filename: `orbis-settings-${id}.orbis-settings`,
      bytes: job.bytes,
      sha256: job.sha256,
    };
  }
  async downloadSession(id: string, ownerId: number, request: Request) {
    const before = await this.sessionContext(request, ownerId);
    const job = await this.ready(id, ownerId);
    return this.openDownload(id, job, async () => {
      await this.verifySession(request, ownerId, before);
      if ((await this.ready(id, ownerId)) !== job) throw fail();
    });
  }
  async download(id: string, ownerId: number, request: Request, credentials: Credentials) {
    const job = await this.owned(id, ownerId);
    await this.verify(request, ownerId, credentials);
    if (job.status !== 'ready' || !job.sha256 || this.closing) throw fail();
    return this.openDownload(id, job);
  }
  private async openDownload(id: string, job: Stored, validate?: () => Promise<void>) {
    const filename = path.join(this.directory(id), 'archive.orbis-settings');
    this.admissions.set(id, (this.admissions.get(id) ?? 0) + 1);
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    let transferred = false;
    try {
      file = await fs.open(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size !== job.bytes || before.mode & 0o077 || before.uid !== process.getuid?.())
        throw fail();
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest('hex') !== job.sha256 || !matches(before, await file.stat()) || !matches(before, await fs.lstat(filename))) throw fail();
      await validate?.();
      if (!matches(before, await file.stat()) || !matches(before, await fs.lstat(filename))) throw fail();
      const stream = file.createReadStream({ start: 0, autoClose: true });
      const readers = this.downloads.get(id) ?? new Set<ReadStream>();
      readers.add(stream);
      this.downloads.set(id, readers);
      stream.once('close', () => {
        readers.delete(stream);
        if (!readers.size) this.downloads.delete(id);
      });
      transferred = true;
      return { stream, bytes: job.bytes };
    } finally {
      if (!transferred) await file?.close();
      const remaining = (this.admissions.get(id) ?? 1) - 1;
      if (remaining) this.admissions.set(id, remaining);
      else this.admissions.delete(id);
    }
  }
  async remove(id: string, ownerId: number, request: Request, credentials: Credentials) {
    await this.owned(id, ownerId);
    await this.verify(request, ownerId, credentials);
    if (this.downloads.get(id)?.size || this.admissions.has(id))
      throw new ConflictException('Wait for this backup download to finish before removing it.');
    if (this.reserved === id) this.reserved = null;
    if (this.active?.id === id) {
      this.active.abort.abort();
      await this.active.done;
    }
    await privateBackupDirectory(this.directory(id));
    await fs.rm(this.directory(id), { recursive: true });
    this.jobs.delete(id);
    return { removed: true };
  }
  async onModuleDestroy() {
    this.closing = true;
    this.reserved = null;
    this.active?.abort.abort();
    await this.active?.done;
    for (const readers of this.downloads.values()) for (const stream of readers) stream.destroy();
  }
}
