import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
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
import { BackupRuntimeService } from './backup-runtime.service';
import { BackupRequirementError, copyBackupFiles, inventoryBackup, packageBackup, privateBackupDirectory } from './backup-files';
import { BackupArchiveError } from './backup-crypto';
import { fullBackupLimits } from './backup-limits';
import { restoreStartupRole } from './backup-restore-startup';
import { acquireRestoreLease } from './backup-restore-lease';
import { BackupRestoreJournal } from './backup-restore-journal';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const savedJob = type({
  version: '1',
  id: 'string',
  ownerId: 'number.integer > 0',
  createdAt: 'number.integer > 0',
  updatedAt: 'number.integer > 0',
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
  completedBytes: job.completedBytes,
  totalBytes: job.totalBytes,
  message: job.message,
  needsRecovery: job.resumePending.length > 0,
  restartRequired: job.restartRequired,
});
const dataRoots = ['state', 'apps', 'repos', 'media', 'user-config', 'traefik'];
const expiry = 24 * 60 * 60_000;

@Injectable()
export class SystemBackupsService implements OnModuleInit, OnModuleDestroy {
  private jobs = new Map<string, Job>();
  private active?: { id: string; abort: AbortController; done: Promise<void> };
  private ready?: Promise<void>;
  private unavailable = false;
  private startupHeld = false;

  constructor(
    private readonly config: ConfigurationService,
    private readonly auth: AuthService,
    private readonly apps: AppsRepository,
    private readonly tasks: TasksService,
    private readonly host: HostUpdatesService,
    private readonly runtime: BackupRuntimeService,
    private readonly logger: LoggerService,
    @Inject(DATABASE) private readonly database: Database,
  ) {}

  private root() {
    return path.join(this.config.get('directories').dataDir, 'backups', 'full');
  }
  private directory(id: string) {
    if (!uuid.test(id)) throw new NotFoundException('Backup not found.');
    return path.join(this.root(), id);
  }
  private async save(job: Job) {
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
  private async expire() {
    for (const [id, job] of this.jobs)
      if (job.status !== 'running' && !job.resumePending.length && Date.now() - job.createdAt > expiry) {
        await fs.rm(this.directory(id), { recursive: true });
        this.jobs.delete(id);
      }
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
      retentionHours: 24,
      jobs: [...this.jobs.values()]
        .filter((job) => job.ownerId === ownerId)
        .map((job) => safeJob(this.active?.id === job.id ? { ...job, status: 'running' } : job)),
    };
  }
  async start(ownerId: number, credentials: { password: string; totpCode?: string }, passphrase: string) {
    await this.initialize();
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
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
      this.active.done = this.export(job, passphrase, abort.signal).finally(() => {
        this.active = undefined;
      });
      return safeJob(job);
    } catch (error) {
      this.active = undefined;
      throw error;
    }
  }
  private async export(job: Job, passphrase: string, signal: AbortSignal) {
    let release: (() => void) | undefined;
    let releaseDisk: (() => void) | undefined;
    let releaseRestore: (() => void) | undefined;
    const directory = this.directory(job.id);
    const content = path.join(directory, 'content');
    const stage = (name: Job['stage'], message: string) => {
      job.stage = name;
      job.message = message;
      job.completedBytes = 0;
      job.totalBytes = null;
    };
    try {
      release = await acquireBackupMaintenance(signal);
      releaseDisk = acquireBackupDisk();
      const restoreStore = path.join(this.config.get('directories').dataDir, 'backups', 'restores');
      releaseRestore = await acquireRestoreLease(restoreStore);
      const restore = await BackupRestoreJournal.active(restoreStore);
      const expectedRoots = Object.fromEntries(dataRoots.map((name) => [name, path.join(this.config.get('directories').dataDir, name)]));
      expectedRoots['app-data'] = this.config.get('directories').appDataDir;
      const excludedDirectories = restore ? await restore.backupExclusions(expectedRoots) : [];
      if ((await this.tasks.read()).tasks.some((task) => ['queued', 'running', 'unconfirmed'].includes(task.status)))
        throw new BackupRequirementError('Wait for app tasks to finish before creating a full backup.');
      const host = await this.host.status();
      if (host.enrolled && !host.available) throw new BackupRequirementError('Reconnect the host service before creating a full backup.');
      if (host.job && ['queued', 'running', 'recovering', 'interrupted'].includes(host.job.state))
        throw new BackupRequirementError('Wait for the server update or recovery to finish before creating a full backup.');
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
      await fs.mkdir(content, { mode: 0o700 });
      stage('database', 'Saving the Orbis database.');
      await this.runtime.dumpDatabase(plan.databaseId, path.join(content, 'database.dump'), signal, (bytes) => {
        job.completedBytes = bytes;
      });
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
      // Release the app outage before compressing/encrypting the immutable snapshot.
      stage('resuming', 'Restarting apps that were running before the backup.');
      await this.runtime.resume(job.resumePending);
      job.resumePending = [];
      await this.save(job);
      release();
      release = undefined;
      await packageBackup({ directory, content, passphrase, signal, progress: (value) => Object.assign(job, value) });
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
  async download(id: string, ownerId: number, credentials: { password: string; totpCode?: string }) {
    await this.initialize();
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    const job = this.owned(id, ownerId);
    if (this.active?.id === id || job.status !== 'succeeded' || Date.now() - job.createdAt > expiry)
      throw new NotFoundException('This backup is not available. Create a new full backup.');
    const file = await fs.open(path.join(this.directory(id), 'backup.orbis'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.mode & 0o077) {
      await file.close();
      throw new ConflictException('The backup file could not be opened safely.');
    }
    return { stream: file.createReadStream(), bytes: stat.size };
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
