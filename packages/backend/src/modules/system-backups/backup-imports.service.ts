import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BadRequestException, ConflictException, Injectable, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type } from 'arktype';
import { installationMode } from '@/common/installation-mode';
import { acquireBackupDisk, BackupDiskBusyError } from '@/common/backup-disk';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AuthService } from '../auth/auth.service';
import { BackupArchiveError, decryptBackup } from './backup-crypto';
import { BackupRequirementError, privateBackupDirectory } from './backup-files';
import { inspectFullBackup, type FullBackupReview } from './backup-import';
import { BackupDatabaseService } from './backup-database.service';
import { restoreStartupRole } from './backup-restore-startup';
import { BackupRestoreJournal } from './backup-restore-journal';
import { acquireRestoreLease } from './backup-restore-lease';
import { BackupSourcePinnedError, createBackupSourceSeal, pinBackupSource, type BackupSourceSeal } from './backup-restore-source';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const retention = 24 * 60 * 60_000;
const reviewRetention = 15 * 60_000;
const stored = type({
  '+': 'reject',
  version: '1',
  id: 'string',
  ownerId: 'number.integer > 0',
  createdAt: 'number.integer > 0',
  updatedAt: 'number.integer > 0',
  status: "'awaiting-upload' | 'uploading' | 'uploaded' | 'reviewing' | 'reviewed' | 'failed' | 'cancelled'",
  stage: "'upload' | 'opening' | 'inspecting' | 'database' | 'complete'",
  completedBytes: 'number >= 0',
  totalBytes: 'number >= 0 | null',
  uploadedBytes: 'number >= 0',
  message: 'string',
});
type ImportJob = typeof stored.infer & { review?: FullBackupReview; seal?: BackupSourceSeal };
type Credentials = { password: string; totpCode?: string };
export type ClaimedBackupSource = Awaited<ReturnType<typeof pinBackupSource>> & { seal: BackupSourceSeal };

@Injectable()
export class BackupImportsService implements OnModuleInit, OnModuleDestroy {
  private jobs = new Map<string, ImportJob>();
  private loading?: Promise<void>;
  private unavailable = false;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private sweeping?: Promise<void>;
  private cleaning = new Set<string>();
  private active?: { id: string; kind: 'upload' | 'review' | 'prepare'; abort: AbortController; done: Promise<void> };

  constructor(
    private readonly config: ConfigurationService,
    private readonly auth: AuthService,
    private readonly logger: LoggerService,
    private readonly database: BackupDatabaseService,
  ) {}
  private root() {
    return path.join(this.config.get('directories').dataDir, 'backups', 'imports');
  }
  private directory(id: string) {
    if (!uuid.test(id)) throw new NotFoundException('Backup import not found.');
    return path.join(this.root(), id);
  }
  private owned(id: string, ownerId: number) {
    this.directory(id);
    const job = this.jobs.get(id);
    if (!job || job.ownerId !== ownerId) throw new NotFoundException('Backup import not found.');
    return job;
  }
  private publicJob(job: ImportJob) {
    const status = this.active?.id === job.id ? { upload: 'uploading', review: 'reviewing', prepare: 'preparing' }[this.active.kind] : job.status;
    return {
      id: job.id,
      status,
      stage: job.stage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedBytes: job.completedBytes,
      totalBytes: job.totalBytes,
      uploadedBytes: job.uploadedBytes,
      message: job.message,
      ...(status === 'reviewed' ? { review: job.review, reviewExpiresAt: job.updatedAt + reviewRetention } : {}),
    };
  }
  private async save(job: ImportJob) {
    const directory = this.directory(job.id);
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    job.updatedAt = Date.now();
    // The review is recomputed after every restart; only non-sensitive job metadata is persisted.
    const { review: _review, seal: _seal, ...metadata } = job;
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(metadata));
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(temporary, path.join(directory, 'job.json'));
      const parent = await fs.open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  onModuleInit() {
    if (restoreStartupRole() === 'verify') return;
    return this.initialize();
  }
  async onModuleDestroy() {
    clearInterval(this.cleanupTimer);
    if (this.active) {
      this.active.abort.abort();
      await this.active.done;
    }
    await this.sweeping;
  }
  private initialize() {
    this.loading ??= this.load();
    return this.loading;
  }
  private async cleanPlaintext(job: ImportJob) {
    for (const name of await fs.readdir(this.directory(job.id)))
      if (!['job.json', 'backup.orbis'].includes(name)) await fs.rm(path.join(this.directory(job.id), name), { force: true, recursive: true });
    job.review = undefined;
    job.seal = undefined;
  }
  private async uploaded(job: ImportJob) {
    try {
      const file = await fs.lstat(path.join(this.directory(job.id), 'backup.orbis'));
      if (!file.isFile() || file.isSymbolicLink() || file.mode & 0o077 || (process.getuid && file.uid !== process.getuid()))
        throw new Error('Unsafe uploaded backup');
      return file.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }
  private async load() {
    try {
      await privateBackupDirectory(this.root());
      const names = await fs.readdir(this.root());
      if (names.length > 32) throw new Error('Too many import directories');
      for (const id of names) {
        if (!uuid.test(id)) throw new Error('Unexpected backup import entry');
        await privateBackupDirectory(this.directory(id));
        const file = path.join(this.directory(id), 'job.json');
        const stat = await fs.lstat(file);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.mode & 0o077 ||
          stat.size > 16 * 1024 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw new Error('Unsafe import journal');
        const job = stored(JSON.parse(await fs.readFile(file, 'utf8')));
        if (job instanceof type.errors || job.id !== id) throw new Error('Invalid import journal');
        this.jobs.set(id, job);
        await this.cleanPlaintext(job);
        const bytes = await this.uploaded(job);
        job.status = bytes ? 'uploaded' : 'awaiting-upload';
        job.stage = 'upload';
        job.uploadedBytes = bytes;
        job.completedBytes = 0;
        job.totalBytes = null;
        job.message = bytes ? 'Enter the backup passphrase to review this file again.' : 'Choose an encrypted Orbis backup to upload.';
        await this.save(job);
      }
      await this.expire();
      this.cleanupTimer = setInterval(
        () =>
          void this.expire().catch(() => {
            this.unavailable = true;
            this.logger.warn('Backup import retention cleanup needs review. Further imports are disabled.');
          }),
        60_000,
      );
      this.cleanupTimer.unref();
    } catch {
      this.unavailable = true;
      this.logger.warn('Backup import storage needs review. Uploaded files were preserved and imports are disabled.');
    }
  }
  private expire() {
    this.sweeping ??= this.expireStored().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }
  private async expireStored() {
    for (const [id, job] of this.jobs) {
      if (this.active?.id === id || this.cleaning.has(id)) continue;
      this.cleaning.add(id);
      try {
        if (Date.now() - job.createdAt > retention) {
          await fs.rm(this.directory(id), { recursive: true });
          this.jobs.delete(id);
        } else if (job.status === 'reviewed' && Date.now() - job.updatedAt > reviewRetention) {
          await this.cleanPlaintext(job);
          job.status = 'uploaded';
          job.stage = 'upload';
          job.completedBytes = 0;
          job.totalBytes = null;
          job.message = 'The review expired. Enter the backup passphrase again to continue.';
          await this.save(job);
        }
      } finally {
        this.cleaning.delete(id);
      }
    }
  }
  private available() {
    if (this.unavailable) throw new ConflictException('Backup import storage needs review. No server data has been changed.');
    if (installationMode().phase !== 'normal') throw new ConflictException('Wait for installation to finish.');
  }
  private begin(job: ImportJob, kind: 'upload' | 'review' | 'prepare', work: (signal: AbortSignal) => Promise<void>) {
    this.available();
    if (this.cleaning.has(job.id)) throw new ConflictException('This backup review is expiring. Try again shortly.');
    if (this.active) throw new ConflictException('Wait for the current backup upload or review to finish.');
    let releaseDisk: () => void;
    try {
      releaseDisk = acquireBackupDisk();
    } catch (error) {
      if (error instanceof BackupDiskBusyError) throw new ConflictException(error.message);
      throw error;
    }
    const abort = new AbortController();
    this.active = { id: job.id, kind, abort, done: Promise.resolve() };
    this.active.done = work(abort.signal).finally(() => {
      this.active = undefined;
      releaseDisk();
    });
    return this.active;
  }
  async list(ownerId: number) {
    await this.initialize();
    if (!this.unavailable) await this.expire();
    return {
      available: !this.unavailable,
      retentionHours: 24,
      jobs: [...this.jobs.values()].filter((job) => job.ownerId === ownerId).map((job) => this.publicJob(job)),
    };
  }
  async create(ownerId: number, credentials: Credentials) {
    await this.initialize();
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    this.available();
    await this.expire();
    if (this.jobs.size >= 32) throw new ConflictException('Remove an older import before uploading another backup.');
    const id = randomUUID();
    const job: ImportJob = {
      version: 1,
      id,
      ownerId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'awaiting-upload',
      stage: 'upload',
      completedBytes: 0,
      totalBytes: null,
      uploadedBytes: 0,
      message: 'Choose an encrypted Orbis backup to upload.',
    };
    this.jobs.set(id, job);
    try {
      await privateBackupDirectory(this.directory(id));
      await this.save(job);
      return this.publicJob(job);
    } catch {
      this.jobs.delete(id);
      throw new ConflictException('The private import directory could not be prepared. No server data has been changed.');
    }
  }
  async receive(id: string, ownerId: number, source: Readable, length?: string) {
    await this.initialize();
    const job = this.owned(id, ownerId);
    if (job.status !== 'awaiting-upload' && job.status !== 'cancelled' && job.status !== 'failed')
      throw new ConflictException('This import already has an uploaded file. Create a new import to choose another.');
    const expected = length === undefined ? null : /^\d+$/.test(length) ? Number(length) : Number.NaN;
    if (expected !== null && (!Number.isSafeInteger(expected) || expected < 52))
      throw new BadRequestException('Choose a complete encrypted Orbis backup.');
    if (await this.uploaded(job)) throw new ConflictException('This import already has an uploaded file.');
    const active = this.begin(job, 'upload', (signal) => this.receiveFile(job, source, expected, signal));
    await active.done;
    return this.publicJob(job);
  }
  private async receiveFile(job: ImportJob, source: Readable, expected: number | null, signal: AbortSignal) {
    const temporary = path.join(this.directory(job.id), 'upload.partial');
    let output: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      await this.cleanPlaintext(job);
      const space = await fs.statfs(this.directory(job.id));
      const maximum = Math.min(Number.MAX_SAFE_INTEGER, Math.floor((space.bavail * space.bsize - 256 * 1024 * 1024) / 2));
      if (maximum < 52 || (expected !== null && expected > maximum))
        throw new BackupRequirementError('There is not enough free storage to receive this backup.');
      output = await fs.open(temporary, 'wx', 0o600);
      const file = output;
      job.status = 'uploading';
      job.stage = 'upload';
      job.completedBytes = 0;
      job.totalBytes = expected;
      job.message = 'Uploading the encrypted backup.';
      await this.save(job);
      let prefix = Buffer.alloc(0);
      await pipeline(
        source,
        async (chunks: AsyncIterable<Buffer>) => {
          for await (const chunk of chunks) {
            signal.throwIfAborted();
            if (job.completedBytes + chunk.length > maximum)
              throw new BackupRequirementError('There is not enough free storage to receive this backup.');
            if (prefix.length < 8) prefix = Buffer.concat([prefix, chunk.subarray(0, 8 - prefix.length)]);
            if (prefix.length === 8 && prefix.toString() !== 'ORBISBK1') throw new BackupRequirementError('Choose an encrypted Orbis backup file.');
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
              if (!bytesWritten) throw new Error('Incomplete upload write');
              offset += bytesWritten;
            }
            job.completedBytes += chunk.length;
          }
        },
        { signal },
      );
      if (job.completedBytes < 52 || (expected !== null && expected !== job.completedBytes))
        throw new BackupRequirementError('The backup upload did not finish. Choose the file again.');
      await output.sync();
      await output.close();
      output = undefined;
      await fs.link(temporary, path.join(this.directory(job.id), 'backup.orbis'));
      job.uploadedBytes = job.completedBytes;
      job.totalBytes = job.uploadedBytes;
      job.status = 'uploaded';
      job.message = 'Backup uploaded. Enter its passphrase to review it.';
    } catch (error) {
      job.status = signal.aborted && !(error instanceof BackupRequirementError) ? 'cancelled' : 'failed';
      job.message = error instanceof BackupRequirementError ? error.message : 'The backup upload did not finish. No server data has been changed.';
    } finally {
      await output?.close();
      await fs.rm(temporary, { force: true });
      try {
        await this.save(job);
      } catch {
        this.unavailable = true;
        this.logger.warn('Backup import status could not be saved. Further imports are disabled.');
      }
    }
  }
  async review(id: string, ownerId: number, credentials: Credentials, passphrase: string) {
    await this.initialize();
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    const job = this.owned(id, ownerId);
    if (typeof passphrase !== 'string' || passphrase.trim().length < 12 || passphrase.length > 1024)
      throw new BadRequestException(new BackupArchiveError('passphrase').message);
    if (!(await this.uploaded(job))) throw new ConflictException('Upload the encrypted backup before reviewing it.');
    this.begin(job, 'review', (signal) => this.inspect(job, passphrase, signal));
    return this.publicJob(job);
  }
  private async inspect(job: ImportJob, passphrase: string, signal: AbortSignal) {
    const directory = this.directory(job.id);
    const archive = path.join(directory, 'opened.tar.gz');
    try {
      await this.cleanPlaintext(job);
      job.status = 'reviewing';
      job.stage = 'opening';
      job.message = 'Opening the encrypted backup.';
      job.completedBytes = 0;
      job.totalBytes = null;
      await this.save(job);
      const uploadBytes = await this.uploaded(job);
      const openingSpace = await fs.statfs(directory);
      if (openingSpace.bavail * openingSpace.bsize < uploadBytes - 52 + 256 * 1024 * 1024)
        throw new BackupRequirementError('There is not enough free storage to open this backup. Free space and retry its review.');
      await decryptBackup({
        source: path.join(directory, 'backup.orbis'),
        destination: archive,
        passphrase,
        signal,
        onProgress: (completedBytes, totalBytes) => {
          job.completedBytes = completedBytes;
          job.totalBytes = totalBytes;
        },
      });
      const space = await fs.statfs(directory);
      const maximum = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(space.bavail * space.bsize - 256 * 1024 * 1024));
      job.stage = 'inspecting';
      job.message = 'Checking backup files and checksums.';
      job.completedBytes = 0;
      job.totalBytes = null;
      const result = await inspectFullBackup({
        archive,
        destination: path.join(directory, 'content'),
        signal,
        maxExpandedBytes: maximum,
        target: {
          orbisVersion: process.env.ORBIS_VERSION ?? 'development',
          runtipiVersion: this.config.get('version'),
          architecture: this.config.get('architecture'),
        },
        progress: (bytes) => {
          job.completedBytes = bytes;
        },
      });
      await fs.rm(archive);
      job.stage = 'database';
      job.message = 'Reviewing database records in an isolated workspace.';
      job.completedBytes = 0;
      job.totalBytes = null;
      await this.save(job);
      const database = await this.database.review(path.join(directory, 'content'), path.join(directory, 'database'), signal, (bytes) => {
        job.completedBytes = bytes;
      });
      job.seal = createBackupSourceSeal(result.integrity, database);
      const seal = await fs.open(path.join(directory, 'review-seal.json'), 'wx', 0o600);
      try {
        await seal.writeFile(JSON.stringify(job.seal));
        await seal.sync();
      } finally {
        await seal.close();
      }
      job.review = {
        ...result.review,
        appCount: database.counts.app,
        databaseValidation: 'validated',
        databaseRecords: Object.values(database.counts).reduce((sum, count) => sum + count, 0),
      };
      job.status = 'reviewed';
      job.stage = 'complete';
      job.totalBytes = job.completedBytes;
      job.message = result.review.compatibility.compatible
        ? 'Backup files and database records verified. Review host and storage requirements before restoring.'
        : 'Backup files and database records verified. Version compatibility needs attention before restore.';
    } catch (error) {
      let cleanupFailed = false;
      await this.cleanPlaintext(job).catch(() => {
        cleanupFailed = true;
        this.unavailable = true;
        this.logger.warn('Backup inspection cleanup needs review. Further imports are disabled.');
      });
      job.status = signal.aborted ? 'cancelled' : 'failed';
      job.message =
        error instanceof BackupArchiveError || error instanceof BackupRequirementError
          ? error.message
          : 'The backup could not be verified. No server data has been changed.';
      if (cleanupFailed) job.message = 'Backup inspection cleanup needs review. No server data has been changed.';
    } finally {
      try {
        await this.save(job);
      } catch {
        this.unavailable = true;
        this.logger.warn('Backup import status could not be saved. Further imports are disabled.');
      }
    }
  }
  abort(id: string, ownerId: number) {
    if (this.jobs.get(id)?.ownerId === ownerId && this.active?.id === id) this.active.abort.abort();
  }
  async claimReviewedSource<T = undefined>(
    id: string,
    ownerId: number,
    credentials: Credentials,
    options: {
      journal: BackupRestoreJournal;
      manifestSha256: string;
      signal: AbortSignal;
      prepare?: (source: ClaimedBackupSource, signal: AbortSignal) => Promise<T>;
    },
  ) {
    await this.initialize();
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    this.available();
    const job = this.owned(id, ownerId);
    const store = path.join(this.config.get('directories').dataDir, 'backups', 'restores');
    if (
      job.status !== 'reviewed' ||
      !job.review ||
      !job.seal ||
      job.review.databaseValidation !== 'validated' ||
      !job.review.compatibility.compatible ||
      job.review.manifestSha256 !== options.manifestSha256 ||
      job.seal.manifest.sha256 !== options.manifestSha256 ||
      Date.now() - job.updatedAt > reviewRetention ||
      Date.now() - job.createdAt > retention ||
      options.journal.directory !== path.join(store, options.journal.state.id)
    )
      throw new ConflictException('Review this backup again before preparing its restore.');
    const expected = structuredClone(job.seal);
    let result: Awaited<ReturnType<typeof pinBackupSource>> | undefined;
    let preparation: T | undefined;
    let failure: unknown;
    const active = this.begin(job, 'prepare', async (abort) => {
      let release: (() => void) | undefined;
      try {
        const signal = AbortSignal.any([abort, options.signal]);
        signal.throwIfAborted();
        release = await acquireRestoreLease(store);
        const state = await options.journal.refresh();
        if (state.phase !== 'staging' || state.decision !== null) throw new ConflictException('This restore is no longer preparing its files.');
        result = await pinBackupSource({
          directory: this.directory(id),
          destination: path.join(options.journal.directory, 'source'),
          expected,
          signal,
        });
        // Ownership moves to the durable restore journal; import expiry must never delete these files.
        this.jobs.delete(id);
        // Materialization and database preparation share this ownership; callbacks must not reacquire these leases.
        preparation = await options.prepare?.({ ...result, seal: expected }, signal);
        signal.throwIfAborted();
      } catch (error) {
        failure = result ? new BackupSourcePinnedError() : error;
        if (result || error instanceof BackupSourcePinnedError) {
          this.jobs.delete(id);
          this.unavailable = true;
          this.logger.warn('Restore preparation needs recovery. The reviewed backup was preserved in its restore journal.');
        }
      } finally {
        release?.();
      }
    });
    await active.done;
    if (failure) throw failure;
    if (!result) throw new ConflictException('The backup could not be prepared. No server data has been changed.');
    return { ...result, seal: expected, preparation };
  }
  async cancel(id: string, ownerId: number) {
    await this.initialize();
    const job = this.owned(id, ownerId);
    if (this.active?.id === id && this.active.kind === 'prepare')
      throw new ConflictException('This backup belongs to a restore in preparation. Cancel it from the restore progress screen.');
    if (this.cleaning.has(id)) throw new ConflictException('This backup review is expiring. Try again shortly.');
    this.cleaning.add(id);
    try {
      if (this.active?.id === id) {
        this.active.abort.abort();
        await this.active?.done;
      } else {
        await this.cleanPlaintext(job);
        job.status = 'cancelled';
        job.message = 'Backup review cancelled. No server data has been changed.';
        await this.save(job);
      }
      return this.publicJob(job);
    } finally {
      this.cleaning.delete(id);
    }
  }
  async remove(id: string, ownerId: number) {
    await this.initialize();
    this.owned(id, ownerId);
    if (this.active?.id === id) throw new ConflictException('Cancel the active upload or review before removing it.');
    if (this.cleaning.has(id)) throw new ConflictException('This backup review is expiring. Try again shortly.');
    this.cleaning.add(id);
    try {
      await fs.rm(this.directory(id), { recursive: true });
      this.jobs.delete(id);
      return { removed: true };
    } finally {
      this.cleaning.delete(id);
    }
  }
}
