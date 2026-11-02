import {
  createCaptureCoherenceReceipt,
  hashCaptureSnapshotFile,
  type CaptureCoherenceReceipt,
  type CaptureCoherenceRuntimeBinding,
} from './time-machine-capture-coherence';
import { QueueFactory } from '../queue/queue.factory';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { type } from 'arktype';
import { sql } from 'drizzle-orm';
import { acquireBackupMaintenance, backupMaintenanceActive, setBackupRecoveryRequired } from '@/common/backup-maintenance';
import { acquireBackupDisk, BackupDiskBusyError } from '@/common/backup-disk';
import { installationMode } from '@/common/installation-mode';
import { ConfigurationService } from '@/core/config/configuration.service';
import { DATABASE, type Database } from '@/core/database/database.module';
import { LoggerService } from '@/core/logger/logger.service';
import { AppsRepository } from '../apps/apps.repository';
import { AuthService } from '../auth/auth.service';
import { TasksService } from '../tasks/tasks.service';
import { HostUpdatesService } from '../host-updates/host-updates.service';
import { BackupRuntimeService, type BackupRuntimePlan } from './backup-runtime.service';
import { BackupRequirementError, copyBackupFiles, inventoryBackup, packageBackup, privateBackupDirectory } from './backup-files';
import { BackupArchiveError } from './backup-crypto';
import { fullBackupLimits } from './backup-limits';
import { restoreStartupRole } from './backup-restore-startup';
import { acquireRestoreLease } from './backup-restore-lease';
import { BackupRestoreJournal } from './backup-restore-journal';
import { BackupRetentionPolicy, backupExpiresAt } from './backup-retention-policy';

export type TransferArchiveGrant = Readonly<{
  requestId: string;
  backupId: string;
  ready: Promise<{ bytes: number }>;
  progress: () => { stage: string; completedBytes: number; totalBytes: number | null };
  open: () => Promise<{ stream: Readable; bytes: number }>;
  cancel: () => Promise<void>;
}>;

export type LocalBackupSnapshot = Readonly<{
  content: string;
  createdAt: number;
  manifestSha256: string;
  software: { orbis: string; runtipi: string; architecture: string };
  files: readonly { name: string; bytes: number }[];
  databaseBytes: number;
  apps: readonly { urn: string; name: string; running: boolean }[];
  sealCoherence?: (binding: CaptureCoherenceRuntimeBinding, signal: AbortSignal) => Promise<CaptureCoherenceReceipt>;
}>;
export type LocalCapturePlan = { runtime: BackupRuntimePlan; apps: { urn: string; userConfigEnabled: boolean }[] };
export type LocalCaptureHooks = {
  maximumPlaintextBytes: number;
  hostPreflight: (signal: AbortSignal) => Promise<void>;
  beforeQuiesce: (plan: LocalCapturePlan, signal: AbortSignal) => Promise<void>;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const savedJob = type({
  version: '1',
  id: 'string',
  ownerId: 'number.integer > 0',
  createdAt: 'number.integer > 0',
  updatedAt: 'number.integer > 0',
  'expiresAt?': 'number.integer > 0',
  status: "'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'",
  stage: "'preparing' | 'inventory' | 'quiescing' | 'database' | 'copying' | 'archiving' | 'encrypting' | 'resuming' | 'complete'",
  completedBytes: 'number >= 0',
  totalBytes: 'number >= 0 | null',
  message: 'string',
  resumePending: type({ id: 'string', project: 'string', running: 'boolean' }).array(),
  restartRequired: 'boolean = false',
});
type Job = typeof savedJob.infer;
const safeJob = (job: Job) => ({
  id: job.id,
  status: job.status,
  stage: job.stage,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  expiresAt: job.expiresAt,
  completedBytes: job.completedBytes,
  totalBytes: job.totalBytes,
  message: job.message,
  needsRecovery: job.resumePending.length > 0,
  restartRequired: job.restartRequired,
});
const dataRoots = ['state', 'apps', 'repos', 'media', 'user-config', 'traefik'];

@Injectable()
export class SystemBackupsService implements OnModuleInit, OnModuleDestroy {
  private jobs = new Map<string, Job>();
  private readonly retention: BackupRetentionPolicy;
  private retentionWork: Promise<unknown> = Promise.resolve();
  private withRetention<T>(work: () => Promise<T>): Promise<T> {
    const result = this.retentionWork.then(work);
    this.retentionWork = result.catch(() => undefined);
    return result;
  }
  private active?: { id: string; abort: AbortController; done: Promise<void> };
  private ready?: Promise<void>;
  private unavailable = false;
  private startupHeld = false;
  private closing = false;
  private readonly transferGrants = new Set<() => Promise<void>>();

  constructor(
    private readonly config: ConfigurationService,
    private readonly auth: AuthService,
    private readonly apps: AppsRepository,
    private readonly tasks: TasksService,
    private readonly host: HostUpdatesService,
    private readonly runtime: BackupRuntimeService,
    private readonly logger: LoggerService,
    @Inject(DATABASE) private readonly database: Database,
    private readonly queues: QueueFactory,
  ) {
    this.retention = new BackupRetentionPolicy(path.join(config.get('directories').dataDir, 'backups', 'settings'));
  }

  private root() {
    return path.join(this.config.get('directories').dataDir, 'backups', 'full');
  }
  private directory(id: string) {
    if (!uuid.test(id)) throw new NotFoundException('Backup not found.');
    return path.join(this.root(), id);
  }
  private async save(job: Job) {
    job.expiresAt = backupExpiresAt(job.createdAt, (await this.retention.read()).retentionHours, job.expiresAt);
    job.updatedAt = Date.now();
    const directory = this.directory(job.id);
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(job));
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
    this.closing = true;
    await Promise.allSettled([...this.transferGrants].map((cancel) => cancel()));
    this.transferGrants.clear();
    if (this.active) {
      this.active.abort.abort();
      await this.active.done;
    }
  }
  private initialize() {
    this.ready ??= this.load();
    return this.ready;
  }
  private async load() {
    try {
      const policy = await this.retention.read();
      await privateBackupDirectory(this.root());
      for (const id of await fs.readdir(this.root())) {
        if (!uuid.test(id)) throw new BackupRequirementError('Unexpected full backup storage entry.');
        await privateBackupDirectory(this.directory(id));
        const file = path.join(this.directory(id), 'job.json');
        const stat = await fs.lstat(file);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > 512 * 1024 ||
          stat.mode & 0o077 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw new BackupRequirementError('Unsafe backup journal.');
        const job = savedJob(JSON.parse(await fs.readFile(file, 'utf8')));
        if (
          job instanceof type.errors ||
          job.id !== id ||
          job.resumePending.length > 1024 ||
          job.resumePending.some((item) => !/^[a-f0-9]{64}$/.test(item.id) || !/^[a-zA-Z0-9_-]+$/.test(item.project))
        )
          throw new BackupRequirementError('Invalid backup journal.');
        this.jobs.set(id, job);
        if (job.expiresAt !== backupExpiresAt(job.createdAt, policy.retentionHours, job.expiresAt)) await this.save(job);
        if (job.restartRequired && !job.resumePending.length) {
          job.restartRequired = false;
          job.message = 'App recovery completed after restarting Orbis.';
          await this.save(job);
        }
        if (job.resumePending.length) setBackupRecoveryRequired(true);
        if (job.resumePending.length) this.startupHeld = true;
        if (job.status === 'running' || job.resumePending.length) {
          job.status = 'interrupted';
          job.stage = 'resuming';
          job.message = 'This backup was interrupted. Review app recovery before starting another backup.';
          await this.save(job);
        }
        await this.cleanPlaintext(job);
      }
      await this.expire();
      setBackupRecoveryRequired([...this.jobs.values()].some((job) => job.resumePending.length > 0));
    } catch {
      setBackupRecoveryRequired(true);
      this.unavailable = true;
      this.logger.warn('Full backup storage needs review. New exports are disabled; existing files have been preserved.');
    }
  }
  private expire() {
    return this.withRetention(async () => {
      const policy = await this.retention.read();
      for (const [id, job] of this.jobs) {
        if (job.expiresAt !== backupExpiresAt(job.createdAt, policy.retentionHours, job.expiresAt)) await this.save(job);
        if (job.status !== 'running' && !job.resumePending.length && Date.now() > (job.expiresAt ?? backupExpiresAt(job.createdAt, 24))) {
          await fs.rm(this.directory(id), { recursive: true });
          this.jobs.delete(id);
        }
      }
    });
  }
  private async cleanPlaintext(job: Job) {
    for (const name of await fs.readdir(this.directory(job.id)))
      if (name !== 'job.json' && name !== 'backup.orbis') {
        await fs.rm(path.join(this.directory(job.id), name), { recursive: true, force: true });
      }
  }
  private assertAvailable() {
    if (this.unavailable) throw new ConflictException('Full backup storage needs review. No new backup was started.');
    if (backupMaintenanceActive())
      throw new ConflictException('Finish backup recovery and any required Orbis restart before starting another export.');
    if (installationMode().phase !== 'normal') throw new ConflictException('Wait for installation to finish.');
  }
  private owned(id: string, ownerId: number) {
    this.directory(id);
    const job = this.jobs.get(id);
    if (!job || job.ownerId !== ownerId) throw new NotFoundException('Backup not found.');
    return job;
  }
  async list(ownerId: number) {
    await this.initialize();
    return {
      available: !this.unavailable,
      retentionHours: this.unavailable ? 24 : (await this.retention.read()).retentionHours,
      jobs: [...this.jobs.values()]
        .filter((job) => job.ownerId === ownerId)
        .map((job) => safeJob(this.active?.id === job.id ? { ...job, status: 'running' } : job)),
    };
  }
  async settings() {
    await this.initialize();
    if (this.unavailable) throw new ConflictException('Backup storage needs review. Existing files have been preserved.');
    return this.retention.read();
  }
  async updateSettings(input: unknown) {
    await this.initialize();
    if (this.unavailable) throw new ConflictException('Backup storage needs review. Existing files have been preserved.');
    if (this.active) throw new ConflictException('Wait for the active backup to finish before changing retention.');
    return this.withRetention(async () => {
      const next = await this.retention.update(input);
      for (const job of this.jobs.values()) {
        const deadline = backupExpiresAt(job.createdAt, next.retentionHours, job.expiresAt);
        if (deadline !== job.expiresAt) {
          job.expiresAt = deadline;
          await this.save(job);
        }
      }
      return next;
    });
  }
  async start(ownerId: number, credentials: { password: string; totpCode?: string }, passphrase: string) {
    await this.initialize();
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    return this.begin(ownerId, passphrase);
  }

  // Server-only capture seam; its controller performs operator/session authorization.
  async startLocalCapture(ownerId: number, passphrase: string, snapshot: (value: LocalBackupSnapshot) => Promise<void>, hooks?: LocalCaptureHooks) {
    await this.initialize();
    if (this.closing) throw new ConflictException('Wait for Orbis to finish restarting before capturing.');
    const job = await this.begin(ownerId, passphrase, snapshot, hooks);
    const operation = this.active?.id === job.id ? this.active.done : Promise.resolve();
    return {
      id: job.id,
      ready: operation.then(async () => {
        const opened = await this.openArchive(job.id, ownerId);
        return { stream: opened.file.createReadStream(), bytes: opened.stat.size };
      }),
    };
  }

  private async begin(ownerId: number, passphrase: string, snapshot?: (value: LocalBackupSnapshot) => Promise<void>, hooks?: LocalCaptureHooks) {
    this.assertAvailable();
    if (typeof passphrase !== 'string' || passphrase.trim().length < 12 || passphrase.length > 1024)
      throw new BadRequestException(new BackupArchiveError('passphrase').message);
    if (this.active || [...this.jobs.values()].some((job) => job.resumePending.length || job.restartRequired))
      throw new ConflictException('Finish the current backup or recover its apps before starting another.');
    // Reserve before any filesystem await so concurrent start requests cannot both win.
    const id = randomUUID();
    const abort = new AbortController();
    this.active = { id, abort, done: Promise.resolve() };
    try {
      await this.expire();
      if (this.jobs.size >= 32) throw new ConflictException('Remove an older backup before creating another.');
      await privateBackupDirectory(this.directory(id));
      const job: Job = {
        version: 1,
        id,
        ownerId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'running',
        stage: 'preparing',
        completedBytes: 0,
        totalBytes: null,
        message: 'Preparing a full backup.',
        resumePending: [],
        restartRequired: false,
      };
      await this.save(job);
      this.jobs.set(id, job);
      const parent = await fs.open(this.root(), 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      this.active.done = this.export(job, passphrase, abort.signal, snapshot, hooks).finally(() => {
        this.active = undefined;
      });
      return safeJob(job);
    } catch (error) {
      this.active = undefined;
      throw error;
    }
  }
  private async export(
    job: Job,
    passphrase: string,
    signal: AbortSignal,
    snapshot?: (value: LocalBackupSnapshot) => Promise<void>,
    hooks?: LocalCaptureHooks,
  ) {
    let release: (() => void) | undefined;
    let releaseDisk: (() => void) | undefined;
    let releaseRestore: (() => void) | undefined;
    let queuePause: Awaited<ReturnType<QueueFactory['pauseForBackup']>> | undefined;
    const directory = this.directory(job.id);
    const content = path.join(directory, 'content');
    const stage = (name: Job['stage'], message: string) => {
      job.stage = name;
      job.message = message;
      job.completedBytes = 0;
      job.totalBytes = null;
    };
    try {
      queuePause = await this.queues.pauseForBackup(signal);
      release = await acquireBackupMaintenance(signal);
      const managedWritesHeldAt = Date.now();
      releaseDisk = acquireBackupDisk();
      const restoreStore = path.join(this.config.get('directories').dataDir, 'backups', 'restores');
      releaseRestore = await acquireRestoreLease(restoreStore);
      const restore = await BackupRestoreJournal.active(restoreStore);
      const expectedRoots = Object.fromEntries(dataRoots.map((name) => [name, path.join(this.config.get('directories').dataDir, name)]));
      expectedRoots['app-data'] = this.config.get('directories').appDataDir;
      const excludedDirectories = restore ? await restore.backupExclusions(expectedRoots) : [];
      if ((await this.tasks.read()).tasks.some((task) => ['queued', 'running', 'unconfirmed'].includes(task.status)))
        throw new BackupRequirementError('Wait for app tasks to finish before creating a full backup.');
      if (hooks) await hooks.hostPreflight(signal);
      else {
        const host = await this.host.status();
        if (host.enrolled && !host.available) throw new BackupRequirementError('Reconnect the host service before creating a full backup.');
        if (host.job && ['queued', 'running', 'recovering', 'interrupted'].includes(host.job.state))
          throw new BackupRequirementError('Wait for the server update or recovery to finish before creating a full backup.');
      }
      const apps = await this.apps.getApps();
      if (apps.some((app) => !['running', 'stopped', 'missing'].includes(app.status)))
        throw new BackupRequirementError('Wait for apps to reach a stable state before creating a full backup.');
      const plan = await this.runtime.plan(apps.map((app) => `${app.appName}_${app.appStoreSlug}`));
      if (
        apps.some(
          (app) => app.status === 'running' && !plan.containers.some((container) => container.project === `${app.appName}_${app.appStoreSlug}`),
        )
      )
        throw new BackupRequirementError('A running app could not be identified in Docker. Refresh its status before creating a full backup.');
      const roots = [
        ...dataRoots.map((name) => ({
          name: `data/${name}`,
          source: path.join(this.config.get('directories').dataDir, name),
          required: name === 'state',
        })),
        { name: 'data/.env', source: this.config.get('envFilePath'), required: true },
        { name: 'app-data', source: this.config.get('directories').appDataDir, required: apps.length > 0 },
      ];
      stage('inventory', 'Checking files and available storage.');
      const estimate = await inventoryBackup(roots, signal, excludedDirectories);
      const size = await this.database.execute(sql`select pg_database_size(current_database())::text as bytes`);
      const databaseBytes = Number(size.rows[0]?.bytes);
      if (!Number.isSafeInteger(databaseBytes) || databaseBytes < 0) throw new BackupRequirementError('Database backup size could not be checked.');
      if (hooks)
        await hooks.beforeQuiesce(
          {
            runtime: plan,
            apps: apps.map((app) => ({ urn: `${app.appName}:${app.appStoreSlug}`, userConfigEnabled: app.userConfigEnabled ?? true })),
          },
          signal,
        );
      const storage = await fs.statfs(directory);
      if (storage.bavail * storage.bsize < 3 * (estimate.totalBytes + databaseBytes) + 256 * 1024 * 1024)
        throw new BackupRequirementError('There is not enough free storage for the full backup and its encrypted output.');
      stage('quiescing', 'Stopping running apps while their data is copied.');
      job.resumePending = plan.containers.filter((container) => container.running);
      await this.save(job);
      for (const container of job.resumePending) {
        signal.throwIfAborted();
        await this.runtime.stop(container);
      }
      await this.runtime.verifyStopped(plan, signal);
      await fs.mkdir(content, { mode: 0o700 });
      stage('database', 'Saving the Orbis database.');
      await this.runtime.dumpDatabase(plan.databaseId, path.join(content, 'database.dump'), signal, (bytes) => {
        job.completedBytes = bytes;
      });
      const databaseSeal = hooks ? await hashCaptureSnapshotFile(path.join(content, 'database.dump'), signal) : undefined;
      stage('inventory', 'Checking the stopped apps’ data.');
      const inventory = await inventoryBackup(roots, signal, excludedDirectories);
      const files = await copyBackupFiles(inventory, content, signal, (value) => Object.assign(job, value));
      await fs.writeFile(
        path.join(content, 'recovery.json'),
        JSON.stringify({ jwtSecret: this.config.get('jwtSecret'), userSettings: this.config.get('userSettings') }),
        { mode: 0o600, flag: 'wx' },
      );
      const manifest = JSON.stringify({
        format: 'orbis-full-backup',
        version: 1,
        createdAt: job.createdAt,
        orbisVersion: process.env.ORBIS_VERSION ?? 'development',
        runtipiVersion: this.config.get('version'),
        architecture: this.config.get('architecture'),
        files,
        directories: inventory.directories,
        containers: plan.containers,
        images: plan.images,
        exclusions: ['logs', 'cache', 'previous-backups', 'container-images', 'restore-recovery-files'],
      });
      if (Buffer.byteLength(manifest) > fullBackupLimits.manifestBytes)
        throw new BackupRequirementError('The backup inventory exceeds the supported manifest size. No partial export is available.');
      await fs.writeFile(path.join(content, 'manifest.json'), manifest, { mode: 0o600, flag: 'wx' });
      let coherenceSealed = false;
      if (snapshot)
        await snapshot({
          content,
          createdAt: job.createdAt,
          manifestSha256: createHash('sha256').update(manifest).digest('hex'),
          software: {
            orbis: process.env.ORBIS_VERSION ?? 'development',
            runtipi: this.config.get('version'),
            architecture: this.config.get('architecture'),
          },
          files,
          databaseBytes: (await fs.stat(path.join(content, 'database.dump'))).size,
          apps: apps.map((app) => ({
            urn: `${app.appName}:${app.appStoreSlug}`,
            name: app.appName,
            running: app.status === 'running',
          })),
          sealCoherence: async (binding, ownSignal) => {
            const check = AbortSignal.any([signal, ownSignal]);
            check.throwIfAborted();
            if (coherenceSealed || !hooks || !release || !releaseRestore || !queuePause || !databaseSeal || !backupMaintenanceActive())
              throw new BackupRequirementError('Capture write barriers are no longer held.');
            const stopped = await this.runtime.verifyStopped(plan, check);
            if ((await this.tasks.read()).tasks.some((task) => ['queued', 'running', 'unconfirmed'].includes(task.status)))
              throw new BackupRequirementError('App tasks changed during the snapshot.');
            const databaseNow = await hashCaptureSnapshotFile(path.join(content, 'database.dump'), check);
            const manifestNow = await hashCaptureSnapshotFile(path.join(content, 'manifest.json'), check);
            if (
              databaseNow.bytes !== databaseSeal.bytes ||
              databaseNow.sha256 !== databaseSeal.sha256 ||
              manifestNow.sha256 !== createHash('sha256').update(manifest).digest('hex')
            )
              throw new BackupRequirementError('Snapshot data changed before coherence sealing.');
            const queueEnd = await queuePause.verify();
            const receipt = createCaptureCoherenceReceipt({
              schema: 'orbis.capture-coherence.v1',
              scope: 'orbis-managed-writers.v1',
              ...binding,
              transactionId: job.id,
              createdAt: job.createdAt,
              sealedAt: Date.now(),
              managedWritesHeldAt,
              database: { containerId: plan.databaseId, ...databaseSeal },
              manifestSha256: manifestNow.sha256,
              apps: stopped
                .map((item) => ({
                  id: item.id,
                  project: item.project,
                  wasRunning: plan.containers.find((original) => original.id === item.id)?.running ?? false,
                  state: 'stopped' as const,
                }))
                .sort((a, b) => a.id.localeCompare(b.id)),
              queueStart: queuePause.initial,
              queueEnd,
            });
            check.throwIfAborted();
            coherenceSealed = true;
            return receipt;
          },
        });
      if (hooks && !coherenceSealed) throw new BackupRequirementError('The capture coherence checks did not complete.');
      await this.runtime.verifyStopped(plan, signal);
      await queuePause.verify();
      // Release the app outage before compressing/encrypting the immutable snapshot.
      stage('resuming', 'Restarting apps that were running before the backup.');
      await this.runtime.resume(job.resumePending);
      job.resumePending = [];
      await this.save(job);
      release();
      release = undefined;
      queuePause.release();
      queuePause = undefined;
      await packageBackup({
        directory,
        content,
        passphrase,
        signal,
        maximumPlaintextBytes: hooks?.maximumPlaintextBytes,
        progress: (value) => Object.assign(job, value),
      });
      job.status = 'succeeded';
      stage('complete', 'Full backup is ready to download. It is kept for 24 hours.');
    } catch (error) {
      job.status = signal.aborted ? 'cancelled' : 'failed';
      job.message =
        error instanceof BackupArchiveError || error instanceof BackupRequirementError || error instanceof BackupDiskBusyError
          ? error.message
          : 'The full backup could not be completed. Check storage, app state and backup requirements.';
      this.logger.warn('A full backup did not complete. No partial export is available.');
      await fs.rm(path.join(directory, 'backup.orbis'), { force: true }).catch(() => undefined);
    } finally {
      if (job.resumePending.length) {
        try {
          await this.runtime.resume(job.resumePending);
          job.resumePending = [];
        } catch {
          setBackupRecoveryRequired(true);
          job.status = 'interrupted';
          job.message = 'Some apps could not be restarted. Recover apps before creating another full backup.';
        }
      }
      release?.();
      try {
        queuePause?.release();
      } catch {
        this.unavailable = true;
        setBackupRecoveryRequired(true);
        this.logger.warn('Backup queue resumption needs review. Further exports are disabled.');
      }
      try {
        await this.cleanPlaintext(job);
        await this.save(job);
      } catch {
        this.unavailable = true;
        this.logger.warn('Full backup cleanup needs review. Further exports are disabled.');
      }
      try {
        releaseRestore?.();
      } catch {
        this.unavailable = true;
        this.logger.warn('The backup restore lock could not be released cleanly. Further exports are disabled.');
      } finally {
        releaseDisk?.();
      }
    }
  }
  async cancel(id: string, ownerId: number) {
    await this.initialize();
    const job = this.owned(id, ownerId);
    if (this.active?.id === id) {
      this.active.abort.abort();
      await this.active?.done;
    }
    return safeJob(job);
  }
  async recover(id: string, ownerId: number, credentials: { password: string; totpCode?: string }) {
    await this.initialize();
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    const job = this.owned(id, ownerId);
    if (this.active) throw new ConflictException('Wait for the active backup to finish.');
    const release = await acquireBackupMaintenance(new AbortController().signal);
    try {
      await this.runtime.resume(job.resumePending);
      job.resumePending = [];
      job.restartRequired = this.startupHeld;
      if (job.restartRequired) job.message = 'Apps recovered. Restart Orbis to finish startup before making changes.';
      await this.save(job);
      setBackupRecoveryRequired([...this.jobs.values()].some((value) => value.resumePending.length > 0 || value.restartRequired));
      return safeJob(job);
    } finally {
      release();
    }
  }
  private async openArchive(id: string, ownerId: number) {
    const job = this.owned(id, ownerId);
    if (this.active?.id === id || job.status !== 'succeeded' || Date.now() > (job.expiresAt ?? backupExpiresAt(job.createdAt, 24)))
      throw new NotFoundException('This backup is not available. Create a new full backup.');
    const file = await fs.open(path.join(this.directory(id), 'backup.orbis'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.mode & 0o077) throw new ConflictException('The backup file could not be opened safely.');
      return { file, stat };
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  async download(id: string, ownerId: number, credentials: { password: string; totpCode?: string }) {
    await this.initialize();
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    const opened = await this.openArchive(id, ownerId);
    return { stream: opened.file.createReadStream(), bytes: opened.stat.size };
  }

  async startTransferExport(
    ownerId: number,
    credentials: { password: string; totpCode?: string },
    passphrase: string,
    requestId: string,
    expiresAt: number,
  ): Promise<TransferArchiveGrant> {
    if (this.closing || !uuid.test(requestId) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 60 * 60_000)
      throw new BadRequestException('The approved restore request expired.');
    const job = await this.start(ownerId, credentials, passphrase);
    return this.transferGrant(ownerId, job.id, requestId, expiresAt);
  }

  private transferGrant(ownerId: number, backupId: string, requestId: string, expiresAt: number): TransferArchiveGrant {
    const operation = this.active?.id === backupId ? this.active.done : Promise.resolve();
    let revoked = false;
    let used = false;
    let output: Readable | undefined;
    const assertValid = () => {
      if (this.closing || revoked || Date.now() >= expiresAt) throw new ConflictException('The approved restore request expired.');
    };
    const cancel = async () => {
      revoked = true;
      this.transferGrants.delete(cancel);
      clearTimeout(timer);
      output?.destroy();
      await this.cancel(backupId, ownerId);
    };
    const timer = setTimeout(
      () => {
        void cancel().catch(() => undefined);
      },
      Math.max(1, expiresAt - Date.now()),
    );
    timer.unref();
    this.transferGrants.add(cancel);
    const signature = (stat: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>['stat']>>) => [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
      stat.mode,
      stat.nlink,
      stat.uid,
    ];
    let sealed: ReturnType<typeof signature> | undefined;
    const ready = operation.then(async () => {
      assertValid();
      const opened = await this.openArchive(backupId, ownerId);
      try {
        assertValid();
        if (opened.stat.nlink !== 1 || (process.getuid && opened.stat.uid !== process.getuid()))
          throw new ConflictException('The backup file could not be opened safely.');
        sealed = signature(opened.stat);
        return { bytes: opened.stat.size };
      } finally {
        await opened.file.close();
      }
    });
    void ready.catch(() => undefined);
    return Object.freeze({
      requestId,
      backupId,
      ready,
      progress: () => {
        const job = this.owned(backupId, ownerId);
        return { stage: job.stage, completedBytes: job.completedBytes, totalBytes: job.totalBytes };
      },
      open: async () => {
        assertValid();
        if (used) throw new ConflictException('This encrypted backup has already been claimed.');
        used = true;
        await ready;
        assertValid();
        const opened = await this.openArchive(backupId, ownerId);
        try {
          assertValid();
          if (!sealed || signature(opened.stat).some((value, index) => value !== sealed?.[index]))
            throw new ConflictException('The approved backup changed. Request a new transfer.');
        } catch (error) {
          await opened.file.close();
          throw error;
        }
        output = opened.file.createReadStream();
        output.once('close', () => {
          clearTimeout(timer);
          this.transferGrants.delete(cancel);
        });
        return { stream: output, bytes: opened.stat.size };
      },
      cancel,
    });
  }
  async remove(id: string, ownerId: number) {
    await this.initialize();
    const job = this.owned(id, ownerId);
    if (this.active?.id === id || job.resumePending.length) throw new ConflictException('Finish or recover this backup before removing it.');
    await fs.rm(this.directory(id), { recursive: true });
    this.jobs.delete(id);
    return { removed: true };
  }
}
