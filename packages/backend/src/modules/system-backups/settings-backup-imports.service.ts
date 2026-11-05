import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { BadRequestException, ConflictException, Injectable, NotFoundException, type OnModuleDestroy } from '@nestjs/common';
import type { Request } from 'express';
import { type } from 'arktype';
import { settingsBackupImportJobSchema } from '@runtipi/common/schemas/settings-backup-import';
import { settingsBackupRestoreSelectionSchema, settingsBackupSelectionContained } from '@runtipi/common/schemas/settings-backup';
import { acquireBackupDisk } from '@/common/backup-disk';
import { enterBackupMutation } from '@/common/backup-maintenance';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AuthService } from '../auth/auth.service';
import { privateBackupDirectory } from './backup-files';
import { fullBackupLimits } from './backup-limits';
import { openSettingsBackupReview } from './settings-backup-review';
import { SettingsBackupSourceService } from './settings-backup-source.service';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha256 = /^[a-f0-9]{64}$/;
const maximum = 2 * 1024 ** 4 + 1024 ** 3 + 4 * 1024 ** 2;
const metadata = type({
  '+': 'reject',
  version: '1',
  id: 'string',
  ownerId: 'number.integer > 0',
  createdAt: 'number.integer > 0',
  updatedAt: 'number.integer > 0',
  status: "'awaiting-upload' | 'uploading' | 'uploaded' | 'reviewing' | 'reviewed' | 'failed' | 'consumed'",
  uploadedBytes: 'number.integer >= 0',
  archiveSha256: 'string | null',
}).narrow(
  (value) =>
    uuid.test(value.id) &&
    Number.isSafeInteger(value.ownerId) &&
    Number.isSafeInteger(value.createdAt) &&
    Number.isSafeInteger(value.updatedAt) &&
    Number.isSafeInteger(value.uploadedBytes) &&
    value.uploadedBytes <= maximum &&
    (value.archiveSha256 === null || sha256.test(value.archiveSha256)),
);
type Metadata = typeof metadata.infer;
type Credentials = { password: string; totpCode?: string };
type Actor = Awaited<ReturnType<AuthService['operatorActionContext']>>;
type Review = Awaited<ReturnType<typeof openSettingsBackupReview>>;
type SelectionValue = Parameters<Parameters<Review['withSelection']>[1]>[0];
type Job = Metadata & { review?: Review; actor?: Actor; completedBytes: number; totalBytes: number | null; message: string };
const failed = () => new ConflictException('The settings backup could not be verified. No settings were restored.');
const sameActor = (a: Actor, b: Actor) => a.userId === b.userId && a.sessionBinding === b.sessionBinding && a.securityBinding === b.securityBinding;
const sameStat = (a: Awaited<ReturnType<typeof fs.stat>>, b: Awaited<ReturnType<typeof fs.stat>>) =>
  (['dev', 'ino', 'size', 'mode', 'uid', 'nlink', 'mtimeMs', 'ctimeMs'] as const).every((key) => a[key] === b[key]);

@Injectable()
export class SettingsBackupImportsService implements OnModuleDestroy {
  private readonly jobs = new Map<string, Job>();
  private loading?: Promise<void>;
  private unavailable = false;
  private closing = false;
  private active?: { id: string; kind: 'upload' | 'review' | 'consume' | 'remove'; abort: AbortController; done: Promise<void> };
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly locations = new WeakMap<Job, { dev: number; ino: number }>();

  constructor(
    private readonly config: ConfigurationService,
    private readonly auth: AuthService,
    private readonly source: SettingsBackupSourceService,
  ) {}
  private root() {
    return path.join(this.config.get('directories').dataDir, 'backups', 'settings-imports');
  }
  private directory(id: string) {
    if (!uuid.test(id)) throw new NotFoundException('Settings backup import not found.');
    return path.join(this.root(), id);
  }
  private owned(id: string, ownerId: number) {
    this.directory(id);
    const job = this.jobs.get(id);
    if (!job || job.ownerId !== ownerId) throw new NotFoundException('Settings backup import not found.');
    return job;
  }
  private publicJob(job: Job) {
    return settingsBackupImportJobSchema.assert({
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      uploadedBytes: job.uploadedBytes,
      completedBytes: job.completedBytes,
      totalBytes: job.totalBytes,
      message: job.message,
      ...(job.status === 'reviewed' && job.review ? { review: job.review.summary } : {}),
    });
  }
  private async checkedDirectory(job: Job) {
    const directory = this.directory(job.id);
    const stat = await fs.lstat(directory);
    const expected = this.locations.get(job);
    if (
      !expected ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      stat.uid !== process.getuid?.() ||
      (await fs.realpath(directory)) !== directory
    )
      throw failed();
    return directory;
  }
  private async save(job: Job) {
    job.updatedAt = Date.now();
    const { version, id, ownerId, createdAt, updatedAt, status, uploadedBytes, archiveSha256 } = job;
    const directory = await this.checkedDirectory(job);
    const temp = path.join(directory, `.${randomUUID()}.tmp`);
    const file = await fs.open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ version, id, ownerId, createdAt, updatedAt, status, uploadedBytes, archiveSha256 }));
      await file.sync();
    } finally {
      await file.close();
    }
    await this.checkedDirectory(job);
    await fs.rename(temp, path.join(directory, 'job.json'));
    const parent = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  private async initialize() {
    this.loading ??= this.load();
    await this.loading;
    if (this.unavailable || this.closing) throw failed();
  }
  private async load() {
    try {
      await privateBackupDirectory(this.root());
      const names = await fs.readdir(this.root());
      if (names.length > 32) throw failed();
      for (const id of names) {
        if (!uuid.test(id)) throw failed();
        const directory = this.directory(id);
        const dir = await fs.lstat(directory);
        if (
          !dir.isDirectory() ||
          dir.isSymbolicLink() ||
          dir.mode & 0o077 ||
          dir.uid !== process.getuid?.() ||
          (await fs.realpath(directory)) !== directory
        )
          throw failed();
        const file = await fs.open(path.join(directory, 'job.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
        let raw: string;
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.uid !== process.getuid?.() || stat.size > 16384) throw failed();
          raw = await file.readFile('utf8');
          if (!sameStat(stat, await file.stat())) throw failed();
        } finally {
          await file.close();
        }
        const stored = metadata(JSON.parse(raw));
        if (stored instanceof type.errors || stored.id !== id || (stored.archiveSha256 !== null && !sha256.test(stored.archiveSha256)))
          throw failed();
        const job: Job = { ...stored, completedBytes: 0, totalBytes: null, message: 'Review the uploaded backup again.' };
        this.locations.set(job, { dev: dir.dev, ino: dir.ino });
        if (stored.uploadedBytes && stored.archiveSha256) {
          try {
            await this.verifyArchive(job, new AbortController().signal);
            job.status = 'uploaded';
          } catch {
            job.status = 'failed';
            job.message = 'This upload could not be verified. Remove it and upload the backup again.';
          }
        } else {
          job.status = 'awaiting-upload';
          job.message = 'Choose a settings backup to upload.';
          try {
            await fs.lstat(path.join(directory, 'upload.partial'));
            job.status = 'failed';
            job.message = 'This upload was interrupted. Remove it and choose the backup again.';
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        this.jobs.set(id, job);
        await this.save(job);
      }
    } catch {
      this.unavailable = true;
    }
  }
  private async actor(ownerId: number, request: Request, credentials: Credentials) {
    const before = await this.auth.operatorActionContext(request);
    if (before.userId !== ownerId) throw failed();
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    if (!sameActor(before, await this.auth.operatorActionContext(request))) throw failed();
    return before;
  }
  private async recheck(actor: Actor, request: Request) {
    if (!sameActor(actor, await this.auth.operatorActionContext(request))) throw failed();
  }
  private reserve(id: string, kind: 'upload' | 'review' | 'consume' | 'remove') {
    if (this.closing || this.active) throw new ConflictException('Wait for the current settings backup operation to finish.');
    let finish!: () => void;
    const active = {
      id,
      kind,
      abort: new AbortController(),
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    this.active = active;
    return {
      active,
      finish: () => {
        if (this.active === active) this.active = undefined;
        finish();
      },
    };
  }
  private admission() {
    const mutation = enterBackupMutation();
    if (!mutation) throw failed();
    try {
      const disk = acquireBackupDisk();
      return () => {
        disk();
        mutation();
      };
    } catch (error) {
      mutation();
      throw error;
    }
  }
  private async verifyArchive(job: Job, signal: AbortSignal) {
    await this.checkedDirectory(job);
    const filename = path.join(this.directory(job.id), 'backup.orbis');
    const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || before.mode & 0o077 || before.uid !== process.getuid?.() || before.size !== job.uploadedBytes)
        throw failed();
      const hash = createHash('sha256');
      let count = 0;
      for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
        hash.update(chunk);
        count += chunk.length;
      }
      if (
        count !== before.size ||
        hash.digest('hex') !== job.archiveSha256 ||
        !sameStat(before, await file.stat()) ||
        !sameStat(before, await fs.lstat(filename))
      )
        throw failed();
      await this.checkedDirectory(job);
    } finally {
      await file.close();
    }
  }
  async list(ownerId: number) {
    await this.initialize();
    return { available: true, jobs: [...this.jobs.values()].filter((job) => job.ownerId === ownerId).map((job) => this.publicJob(job)) };
  }
  private scheduleExpiry(job: Job, review: Review, delay = Math.max(0, review.summary.expiresAt - Date.now())) {
    clearTimeout(this.expiryTimers.get(job.id));
    const timer = setTimeout(() => {
      this.expiryTimers.delete(job.id);
      if (this.closing || job.review !== review) return;
      if (this.active) {
        this.scheduleExpiry(job, review, 1000);
        return;
      }
      const reservation = this.reserve(job.id, 'remove');
      void (async () => {
        try {
          await review.dispose();
          job.review = undefined;
          job.actor = undefined;
          job.status = 'uploaded';
          job.message = 'The review expired. Review the backup again.';
          await this.save(job);
        } catch {
          this.unavailable = true;
        } finally {
          reservation.finish();
        }
      })();
    }, delay);
    timer.unref();
    this.expiryTimers.set(job.id, timer);
  }
  async create(ownerId: number, request: Request, credentials: Credentials) {
    await this.initialize();
    const actor = await this.actor(ownerId, request, credentials);
    const reservation = this.reserve('', 'remove');
    try {
      if (this.jobs.size >= 32) throw new ConflictException('Remove an older settings backup import first.');
      const id = randomUUID();
      const now = Date.now();
      const job: Job = {
        version: 1,
        id,
        ownerId,
        createdAt: now,
        updatedAt: now,
        status: 'awaiting-upload',
        uploadedBytes: 0,
        archiveSha256: null,
        completedBytes: 0,
        totalBytes: null,
        message: 'Choose a settings backup to upload.',
      };
      await this.recheck(actor, request);
      await fs.mkdir(this.directory(id), { mode: 0o700 });
      const location = await fs.lstat(this.directory(id));
      this.locations.set(job, { dev: location.dev, ino: location.ino });
      await this.save(job);
      this.jobs.set(id, job);
      return this.publicJob(job);
    } finally {
      reservation.finish();
    }
  }
  async upload(id: string, ownerId: number, input: Readable, length: unknown, signal: AbortSignal) {
    await this.initialize();
    const job = this.owned(id, ownerId);
    if ((job.status !== 'awaiting-upload' && job.status !== 'failed') || job.uploadedBytes || job.archiveSha256) throw failed();
    const expected = length === undefined ? null : typeof length === 'string' && /^\d+$/.test(length) ? Number(length) : Number.NaN;
    if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1 || expected > maximum))
      throw new BadRequestException('Invalid backup file length.');
    const reservation = this.reserve(id, 'upload');
    let release: (() => void) | undefined;
    const temp = path.join(this.directory(id), 'upload.partial');
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    let ownsTemporary = false;
    const combined = AbortSignal.any([signal, reservation.active.abort.signal]);
    const cancelInput = () => input.destroy();
    combined.addEventListener('abort', cancelInput, { once: true });
    try {
      release = this.admission();
      combined.throwIfAborted();
      await this.checkedDirectory(job);
      const space = await fs.statfs(this.directory(id), { bigint: true });
      const limit = Math.min(maximum, Number((space.bavail * space.bsize - BigInt(fullBackupLimits.reserveBytes)) / 3n));
      if (limit < 1 || (expected !== null && expected > limit)) throw failed();
      file = await fs.open(temp, 'wx', 0o600);
      ownsTemporary = true;
      const hash = createHash('sha256');
      job.status = 'uploading';
      job.completedBytes = 0;
      job.totalBytes = expected;
      job.message = 'Uploading the settings backup.';
      await this.save(job);
      for await (const raw of input) {
        combined.throwIfAborted();
        const chunk = Buffer.from(raw);
        job.completedBytes += chunk.length;
        if (job.completedBytes > limit || (expected !== null && job.completedBytes > expected)) throw failed();
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const written = await file.write(chunk, offset, chunk.length - offset);
          if (!written.bytesWritten) throw failed();
          offset += written.bytesWritten;
        }
      }
      combined.throwIfAborted();
      if (!job.completedBytes || (expected !== null && job.completedBytes !== expected)) throw failed();
      await file.sync();
      await file.close();
      file = undefined;
      await this.checkedDirectory(job);
      await fs.link(temp, path.join(this.directory(id), 'backup.orbis'));
      await fs.unlink(temp);
      job.uploadedBytes = job.completedBytes;
      job.archiveSha256 = hash.digest('hex');
      await this.verifyArchive(job, combined);
      job.status = 'uploaded';
      job.message = 'Backup uploaded. Enter its passphrase to review it.';
      await this.save(job);
      return this.publicJob(job);
    } catch (error) {
      job.status = 'failed';
      job.message = 'The upload did not finish. No settings were restored.';
      await this.save(job).catch(() => {
        this.unavailable = true;
      });
      throw error;
    } finally {
      combined.removeEventListener('abort', cancelInput);
      try {
        await file?.close();
        await this.checkedDirectory(job);
        if (ownsTemporary) await fs.rm(temp, { force: true });
      } catch {
        this.unavailable = true;
      } finally {
        release?.();
        reservation.finish();
      }
    }
  }
  async review(id: string, ownerId: number, request: Request, credentials: Credentials, passphrase: string) {
    await this.initialize();
    const actor = await this.actor(ownerId, request, credentials);
    const job = this.owned(id, ownerId);
    if (
      !job.uploadedBytes ||
      !job.archiveSha256 ||
      typeof passphrase !== 'string' ||
      passphrase.length < 8 ||
      passphrase.length > 1024 ||
      !passphrase.trim()
    )
      throw failed();
    const reservation = this.reserve(id, 'review');
    let release: (() => void) | undefined;
    try {
      release = this.admission();
    } catch (error) {
      reservation.finish();
      throw error;
    }
    job.status = 'reviewing';
    job.completedBytes = 0;
    job.totalBytes = null;
    job.message = 'Verifying the settings backup.';
    const start = (async () => {
      let opened: Review | undefined;
      try {
        await job.review?.dispose();
        job.review = undefined;
        job.actor = undefined;
        await this.save(job);
        await this.recheck(actor, request);
        await this.verifyArchive(job, reservation.active.abort.signal);
        const directory = path.join(this.directory(id), `review-${randomUUID()}`);
        opened = await openSettingsBackupReview({
          source: path.join(this.directory(id), 'backup.orbis'),
          directory,
          passphrase,
          signal: reservation.active.abort.signal,
          inspect: this.source.inspectors(passphrase, this.directory(id)),
          progress: (bytes) => {
            job.completedBytes = bytes;
          },
        });
        await this.recheck(actor, request);
        await this.verifyArchive(job, reservation.active.abort.signal);
        if (opened.summary.archiveSha256 !== job.archiveSha256) throw failed();
        job.review = opened;
        opened = undefined;
        job.actor = actor;
        job.status = 'reviewed';
        job.message = 'Backup contents verified.';
        await this.save(job);
        this.scheduleExpiry(job, job.review);
      } catch {
        await opened?.dispose().catch(() => {
          this.unavailable = true;
        });
        await job.review?.dispose().catch(() => {
          this.unavailable = true;
        });
        job.review = undefined;
        job.actor = undefined;
        job.status = 'failed';
        job.message = 'The backup could not be verified. No settings were restored.';
        await this.save(job).catch(() => {
          this.unavailable = true;
        });
      } finally {
        release?.();
        reservation.finish();
      }
    })();
    return { job: this.publicJob(job), start };
  }
  async withSelection<T>(
    id: string,
    ownerId: number,
    request: Request,
    credentials: Credentials,
    selection: unknown,
    consume: (value: SelectionValue, recheck: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    await this.initialize();
    const actor = await this.actor(ownerId, request, credentials);
    const job = this.owned(id, ownerId);
    const reservation = this.reserve(id, 'consume');
    let release: (() => void) | undefined;
    try {
      const review = job.review;
      if (job.status !== 'reviewed' || !review || !job.actor || !sameActor(actor, job.actor) || Date.now() >= review.summary.expiresAt)
        throw failed();
      release = this.admission();
      await this.verifyArchive(job, reservation.active.abort.signal);
      await this.recheck(actor, request);
      return await review.withSelection(selection, async (value) => {
        await this.recheck(actor, request);
        job.status = 'consumed';
        job.message = 'This review has been used.';
        await this.save(job);
        await this.recheck(actor, request);
        if (Date.now() >= review.summary.expiresAt) throw failed();
        release?.();
        release = undefined;
        return consume(value, async () => {
          reservation.active.abort.signal.throwIfAborted();
          await this.recheck(actor, request);
          if (Date.now() >= review.summary.expiresAt) throw failed();
        });
      });
    } finally {
      release?.();
      try {
        if (job.status === 'consumed') {
          clearTimeout(this.expiryTimers.get(id));
          this.expiryTimers.delete(id);
          await job.review?.dispose();
          job.review = undefined;
          job.actor = undefined;
        }
      } finally {
        reservation.finish();
      }
    }
  }
  async confirmSelection(id: string, ownerId: number, request: Request, credentials: Credentials, selection: unknown) {
    await this.initialize();
    const actor = await this.actor(ownerId, request, credentials);
    const job = this.owned(id, ownerId);
    const selected = settingsBackupRestoreSelectionSchema.assert(selection);
    const summary = job.review?.summary;
    if (
      this.active ||
      job.status !== 'reviewed' ||
      !job.actor ||
      !sameActor(actor, job.actor) ||
      !summary ||
      Date.now() >= summary.expiresAt ||
      selected.reviewId !== summary.reviewId ||
      selected.archiveSha256 !== summary.archiveSha256 ||
      !settingsBackupSelectionContained(summary.available, selected.contents)
    )
      throw failed();
    return structuredClone(summary);
  }
  async remove(id: string, ownerId: number, request: Request, credentials: Credentials) {
    await this.initialize();
    const actor = await this.actor(ownerId, request, credentials);
    const job = this.owned(id, ownerId);
    if (this.active?.id === id) {
      if (this.active.kind !== 'consume') this.active.abort.abort();
      await this.active.done;
    }
    const reservation = this.reserve(id, 'remove');
    try {
      await this.recheck(actor, request);
      clearTimeout(this.expiryTimers.get(id));
      this.expiryTimers.delete(id);
      await job.review?.dispose();
      await this.checkedDirectory(job);
      await fs.rm(this.directory(id), { recursive: true });
      this.jobs.delete(id);
      return { removed: true };
    } finally {
      reservation.finish();
    }
  }
  async onModuleDestroy() {
    this.closing = true;
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    if (this.active) {
      if (this.active.kind !== 'consume') this.active.abort.abort();
      await this.active.done;
    }
    for (const job of this.jobs.values()) await job.review?.dispose();
  }
}
