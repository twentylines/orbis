import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ConflictException, Inject, Injectable, NotFoundException, Optional, type OnModuleDestroy } from '@nestjs/common';
import type Dockerode from 'dockerode';
import type { Request } from 'express';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { acquireBackupMaintenance, backupMaintenanceActive, setRestoreRecoveryRequired } from '@/common/backup-maintenance';
import { installationMode } from '@/common/installation-mode';
import { AuthService } from '../auth/auth.service';
import { AccountSecurityService } from '../auth/account-security.service';
import { authorizeBackupRestoreSession } from './backup-session-authorization';
import { AppsRepository } from '../apps/apps.repository';
import { TasksService } from '../tasks/tasks.service';
import { HostUpdatesService } from '../host-updates/host-updates.service';
import { DOCKERODE } from '../docker/docker.module';
import { BackupRuntimeService } from './backup-runtime.service';
import { BackupImportsService } from './backup-imports.service';
import { BackupRestoreJournal } from './backup-restore-journal';
import { readRestoreBootstrap, requestRestoreCancellation } from './backup-restore-bootstrap';
import { BackupRestoreDockerRuntime, readRestoreOperation, snapshotRestoreContainer } from './backup-restore-runtime';
import { discardUnstartedRestoreHandoff, prepareRestoreHandoff } from './backup-restore-handoff';
import { restoreStartupRole } from './backup-restore-startup';
import { readRestoreProgress } from './backup-restore-progress';
import { BackupRequirementError } from './backup-files';
import { cleanupSettledRestoreAuxiliaries } from './backup-restore-terminal-cleanup';
import { readTerminalOwnership } from './backup-restore-terminal-record';
import type { TimeMachineRestoreBinding } from '@runtipi/common/schemas/time-machine-restore';
import { readRetainedRestoreReceipt, type RetainedRestorePermit } from './time-machine-restore-admission';
import { TimeMachineStore } from './time-machine-store';
import { stageRetainedRuntime } from './time-machine-retained-stage';
import { reviewRetainedRoot, RetainedRootTransaction } from './time-machine-retained-root-client';
import { bindRetainedJournal, readRetainedBoundRecord } from './time-machine-retained-bootstrap';
import { verifyRetainedRootWorker } from './time-machine-retained-context';
import { retainedPlatformSchema } from './time-machine-retained-phase-client';
import { canonicalRuntimeJson } from './time-machine-runtime-payload';
import { type } from 'arktype';
import { readRootRestorationState } from '@/common/restoration-root-status';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const settled = (phase: string) => ['completed', 'rolled-back', 'discarded'].includes(phase);
const matchingOutcome = (phase: string, status?: string) => status === (phase === 'completed' ? 'succeeded' : 'rolled-back');
type Credentials = { password: string; totpCode?: string };
const failed = () => new ConflictException('Restore recovery needs review. Your server data and backup have been preserved.');

@Injectable()
export class BackupRestoresService implements OnModuleDestroy {
  private startup?: Promise<void>;
  private startupHeld = false;
  private preparing = false;
  private recoveringRetained = false;
  private abort?: AbortController;
  private pending?: { id: string; release: () => void };
  private restart?: { id: string; controller: ReturnType<typeof snapshotRestoreContainer> };
  private recoveryHold?: { id: string; nonce: string };
  private retainedWatch?: ReturnType<typeof setTimeout>;
  private closing = false;
  private readonly launches = new Map<string, Promise<void>>();

  constructor(
    private readonly config: ConfigurationService,
    private readonly auth: AuthService,
    private readonly apps: AppsRepository,
    private readonly tasks: TasksService,
    private readonly host: HostUpdatesService,
    private readonly runtime: BackupRuntimeService,
    private readonly imports: BackupImportsService,
    private readonly logger: LoggerService,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
    @Optional() private readonly security?: AccountSecurityService,
  ) {}
  private directories() {
    const value = this.config.get('directories');
    return { data: value.dataDir, appData: value.appDataDir, cache: '/cache' };
  }
  private store() {
    return path.join(this.directories().data, 'backups', 'restores');
  }
  prepareStartup() {
    this.startup ??= this.inspectStartup();
    return this.startup;
  }
  private async inspectStartup() {
    if (restoreStartupRole() !== 'ordinary') return;
    try {
      const journal = await BackupRestoreJournal.active(this.store());
      this.startupHeld = Boolean(journal && !settled(journal.state.phase));
      if (journal && (await this.isRetainedJournal(journal))) {
        this.startupHeld = true;
        const receipt = await readRetainedRestoreReceipt(journal);
        if (receipt) this.watchRetainedTerminal(journal, receipt.ownerId);
      }
      if (!journal && (await readRootRestorationState()) === 'checking') {
        const latest = await BackupRestoreJournal.latest(this.store());
        if (latest && (await this.isRetainedJournal(latest))) {
          const receipt = await readRetainedRestoreReceipt(latest);
          if (!receipt) throw failed();
          this.startupHeld = true;
          this.watchRetainedTerminal(latest, receipt.ownerId);
        }
      }
      setRestoreRecoveryRequired(this.startupHeld);
    } catch {
      this.startupHeld = true;
      setRestoreRecoveryRequired(true);
      this.logger.warn('Restore storage needs review. App changes remain held.');
    }
  }
  async startRetainedSettlement() {
    const journal = (await BackupRestoreJournal.active(this.store())) ?? (await BackupRestoreJournal.latest(this.store()));
    if (!journal || !(await this.isRetainedJournal(journal))) return;
    const receipt = await readRetainedRestoreReceipt(journal);
    if (!receipt) throw failed();
    this.startupHeld = true;
    setRestoreRecoveryRequired(true);
    this.watchRetainedTerminal(journal, receipt.ownerId);
  }
  onModuleDestroy() {
    this.closing = true;
    if (this.retainedWatch) clearTimeout(this.retainedWatch);
    this.abort?.abort();
  }
  private watchRetainedTerminal(journal: BackupRestoreJournal, ownerId: number) {
    if (this.closing || this.retainedWatch) return;
    const poll = async () => {
      this.retainedWatch = undefined;
      if (this.closing) return;
      try {
        const active = await BackupRestoreJournal.active(this.store());
        if (!active || settled(active.state.phase) || (active.state.phase === 'staging' && (await readRootRestorationState()) === 'checking')) {
          try {
            await cleanupSettledRestoreAuxiliaries({
              docker: this.docker,
              store: this.store(),
              controller: os.hostname(),
              data: this.directories().data,
              signal: AbortSignal.timeout(30000),
            });
          } catch {
            /* The protected root may still be finishing. */
          }
        }
        if (!(await BackupRestoreJournal.active(this.store())) && (await readRootRestorationState()) === 'idle') {
          if (this.pending?.id === journal.state.id) {
            this.pending.release();
            this.pending = undefined;
          }
          this.startupHeld = false;
          this.recoveryHold = undefined;
          setRestoreRecoveryRequired(false);
          return;
        }
        const status = await this.retainedStatus(journal, ownerId);
        if (status.job.status === 'succeeded' || status.job.status === 'rolled-back') return;
      } catch {
        // Keep the hold until the protected status is available and verified.
      }
      if (!this.closing) {
        this.retainedWatch = setTimeout(() => void poll(), 2000);
        this.retainedWatch.unref();
      }
    };
    this.retainedWatch = setTimeout(() => void poll(), 2000);
    this.retainedWatch.unref();
  }
  private async isRetainedJournal(journal: BackupRestoreJournal) {
    try {
      await fs.lstat(path.join(journal.directory, 'retained-root-request.json'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw failed();
    }
  }
  private async active(id: string) {
    if (!uuid.test(id)) throw new NotFoundException('Restore not found.');
    const journal = await BackupRestoreJournal.active(this.store());
    if (!journal || journal.state.id !== id) throw new NotFoundException('Restore not found.');
    return journal;
  }
  private async ownController(journal: BackupRestoreJournal) {
    const current = await this.docker.getContainer(os.hostname()).inspect();
    if (current.Id !== journal.state.originalController || current.Id !== journal.state.candidateController) throw failed();
    return current;
  }
  private async inertDiscard(journal: BackupRestoreJournal) {
    if (journal.state.phase !== 'discarded') return false;
    try {
      for (const file of ['bootstrap.json', 'runtime.json', 'worker-status.json', ...journal.state.roots.map((name) => `roots/${name}/swap.json`)]) {
        try {
          await fs.lstat(path.join(journal.directory, file));
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
        }
      }
      const current = await this.ownController(journal);
      if (!current.State.Running || current.State.Restarting || current.State.Paused) return false;
      const ownership = await readTerminalOwnership(journal.directory, journal.state);
      if (ownership && snapshotRestoreContainer(current).fingerprint !== ownership.fingerprint) return false;
      for (const [id, role] of [
        [journal.state.worker, 'worker'],
        [journal.state.verifierController, 'verifier'],
      ] as const) {
        if (!id) return false;
        try {
          const value = await this.docker.getContainer(id).inspect();
          if (
            value.Id !== id ||
            value.State.Running ||
            value.State.Restarting ||
            value.State.Paused ||
            value.RestartCount ||
            !(Date.parse(value.State.StartedAt) <= 0) ||
            value.Config.Labels?.['io.orbis.restore'] !== journal.state.id ||
            value.Config.Labels?.['io.orbis.restore.nonce'] !== journal.state.nonce ||
            value.Config.Labels?.['io.orbis.restore.role'] !== role ||
            (ownership && snapshotRestoreContainer(value).fingerprint !== ownership[role].fingerprint)
          )
            return false;
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 404) return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }
  private async recoveryWorker(journal: BackupRestoreJournal) {
    await this.ownController(journal);
    const bootstrap = await readRestoreBootstrap(journal);
    const preparing = ['staging', 'preparing', 'discarded'].includes(journal.state.phase);
    const identity = preparing ? bootstrap.identity : await readRestoreOperation(journal);
    const runtime = new BackupRestoreDockerRuntime(this.docker, journal, identity, this.directories());
    await runtime.verifyWorker(journal.state.worker, { preparing });
    const worker = await this.docker.getContainer(journal.state.worker).inspect();
    if (worker.State.Paused) throw failed();
    return worker;
  }
  private holdRecovery(journal: BackupRestoreJournal) {
    this.recoveryHold = { id: journal.state.id, nonce: journal.state.nonce };
    setRestoreRecoveryRequired(true);
  }
  async status() {
    await this.prepareStartup();
    const journal = await BackupRestoreJournal.latest(this.store());
    if (!journal) return { job: null };
    let retained = false;
    try {
      await fs.lstat(path.join(journal.directory, 'retained-root-request.json'));
      retained = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (retained) {
      const receipt = await readRetainedRestoreReceipt(journal);
      if (!receipt) throw failed();
      return this.retainedStatus(journal, receipt.ownerId);
    }
    const state = journal.state;
    const finished = settled(state.phase);
    let progress: Awaited<ReturnType<typeof readRestoreProgress>>;
    let progressUnavailable = false;
    let progressInvalid = false;
    try {
      progress = await readRestoreProgress(journal);
    } catch {
      progressUnavailable = true;
      progressInvalid = true;
    }
    let worker: Dockerode.ContainerInspectInfo | undefined;
    try {
      const value = await this.docker.getContainer(state.worker).inspect();
      if (
        value.Id !== state.worker ||
        value.Config.Labels?.['io.orbis.restore'] !== state.id ||
        value.Config.Labels?.['io.orbis.restore.nonce'] !== state.nonce ||
        value.Config.Labels?.['io.orbis.restore.role'] !== 'worker'
      )
        throw failed();
      worker = value;
    } catch {
      if (!finished) progressUnavailable = true;
    }
    const restarting = this.restart?.id === state.id;
    const ready = this.pending?.id === state.id;
    const running = worker?.State.Running || worker?.State.Restarting;
    const inert = finished && !progressUnavailable && !progress && (await this.inertDiscard(journal));
    const outcomePending = finished && !inert && !matchingOutcome(state.phase, progress?.status);
    if (finished && !progress && !inert) progressUnavailable = true;
    if (
      this.recoveryHold?.id === state.id &&
      this.recoveryHold.nonce === state.nonce &&
      finished &&
      !progressUnavailable &&
      matchingOutcome(state.phase, progress?.status) &&
      !this.startupHeld &&
      !restarting &&
      !ready
    ) {
      this.recoveryHold = undefined;
      setRestoreRecoveryRequired(false);
    }
    const needsRecovery =
      !restarting &&
      !ready &&
      ((finished && (this.startupHeld || (outcomePending && (progressUnavailable || !running || progress?.status === 'recovery-required')))) ||
        (!finished && (progressUnavailable || !running || progress?.status === 'recovery-required')));
    const status = restarting
      ? 'running'
      : needsRecovery
        ? 'recovery-required'
        : outcomePending
          ? 'running'
          : state.phase === 'completed'
            ? 'succeeded'
            : finished
              ? 'rolled-back'
              : ready
                ? 'ready'
                : 'running';
    const stage = restarting ? 'restarting' : outcomePending ? 'recovering' : finished ? 'complete' : (progress?.stage ?? state.phase);
    const message = restarting
      ? 'Finishing recovery. The page will reload automatically.'
      : status === 'succeeded'
        ? 'The restored server is ready.'
        : status === 'rolled-back'
          ? inert
            ? 'Restore stopped before server data was changed. The uploaded backup was not applied.'
            : 'Restore rolled back. Your original server was recovered; the uploaded backup was not applied.'
          : status === 'recovery-required'
            ? 'Restore recovery needs review. Your data has been preserved.'
            : outcomePending
              ? state.phase === 'completed'
                ? 'Confirming restore completion.'
                : 'Recovering your original server.'
              : status === 'ready'
                ? 'Restore is ready to start.'
                : stage === 'recovering'
                  ? 'Recovering your original server.'
                  : ['files', 'database', 'sealing', 'prepared', 'checking'].includes(stage)
                    ? 'Preparing configuration and app data.'
                    : 'Restoring configuration and app data.';
    return {
      job: {
        id: state.id,
        status,
        stage,
        phase: state.phase,
        message,
        needsRecovery,
        progressUnavailable,
        canCancel: !finished && state.decision !== 'commit',
        canRecover:
          needsRecovery &&
          !progressInvalid &&
          (!finished ||
            (this.startupHeld && (inert || matchingOutcome(state.phase, progress?.status))) ||
            (state.phase !== 'completed' && Boolean(worker && !running && !worker.State.Paused))),
        ...(progress?.preparation ? { preparation: progress.preparation } : {}),
        ...(progress?.updatedAt ? { updatedAt: progress.updatedAt } : {}),
        ...(progress?.check ? { check: progress.check } : {}),
      },
    };
  }
  async prepare(importId: string, ownerId: number, credentials: Credentials, manifestSha256: string) {
    if (!uuid.test(importId) || !/^[a-f0-9]{64}$/.test(manifestSha256)) throw new NotFoundException('Reviewed backup not found.');
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    return this.prepareAuthorized(importId, ownerId, manifestSha256, { kind: 'legacy', credentials });
  }
  async prepareForSession(importId: string, ownerId: number, request: Request, credentials: Credentials | undefined, manifestSha256: string) {
    if (!uuid.test(importId) || !/^[a-f0-9]{64}$/.test(manifestSha256)) throw new NotFoundException('Reviewed backup not found.');
    const actor = await authorizeBackupRestoreSession(this.auth, this.security, request, ownerId, credentials);
    return this.prepareAuthorized(importId, ownerId, manifestSha256, { kind: 'session', request, credentials, actor });
  }
  private async prepareAuthorized(
    importId: string,
    ownerId: number,
    manifestSha256: string,
    authorization:
      | { kind: 'legacy'; credentials: Credentials }
      | { kind: 'session'; request: Request; credentials: Credentials | undefined; actor: Awaited<ReturnType<typeof authorizeBackupRestoreSession>> },
  ) {
    await this.prepareStartup();
    if (this.preparing || this.pending || backupMaintenanceActive() || installationMode().phase !== 'normal')
      throw new ConflictException('Finish the current operation or restore recovery before starting another restore.');
    this.preparing = true;
    const abort = new AbortController();
    this.abort = abort;
    let release: (() => void) | undefined;
    try {
      release = await acquireBackupMaintenance(abort.signal);
      if ((await this.tasks.read()).tasks.some((task) => ['queued', 'running', 'unconfirmed'].includes(task.status)))
        throw new ConflictException('Wait for app tasks to finish before restoring.');
      const host = await this.host.status();
      if ((host.enrolled && !host.available) || (host.job && ['queued', 'running', 'recovering', 'interrupted'].includes(host.job.state)))
        throw new ConflictException('Finish the server update or recovery before restoring.');
      const apps = await this.apps.getApps();
      if (apps.some((app) => !['running', 'stopped', 'missing'].includes(app.status)))
        throw new ConflictException('Wait for apps to reach a stable state before restoring.');
      await cleanupSettledRestoreAuxiliaries({
        docker: this.docker,
        store: this.store(),
        controller: os.hostname(),
        data: this.directories().data,
        signal: abort.signal,
      });
      const plan = await this.runtime.plan(apps.map((app) => `${app.appName}_${app.appStoreSlug}`));
      if (
        apps.some(
          (app) => app.status === 'running' && !plan.containers.some((container) => container.project === `${app.appName}_${app.appStoreSlug}`),
        )
      )
        throw new ConflictException('A running app could not be identified. Refresh Apps before restoring.');
      const database = this.config.get('database');
      const result = await prepareRestoreHandoff({
        docker: this.docker,
        controller: os.hostname(),
        ownerId,
        connection: { host: database.host, port: database.port, user: database.username, password: database.password, database: database.database },
        queue: this.config.get('queue'),
        apps: plan.containers.map((container) => ({ id: container.id, project: container.project })),
        directories: this.directories(),
        signal: abort.signal,
        claimReviewedSource: async (journal, accept) => {
          const options = { journal, manifestSha256, signal: abort.signal, prepare: accept };
          if (authorization.kind === 'session')
            await this.imports.claimReviewedSourceForSession(
              importId,
              ownerId,
              authorization.request,
              authorization.credentials,
              authorization.actor,
              options,
            );
          else await this.imports.claimReviewedSource(importId, ownerId, authorization.credentials, options);
        },
      });
      setRestoreRecoveryRequired(true);
      this.pending = { id: result.journal.state.id, release };
      release = undefined;
      return await this.status();
    } catch (error) {
      if (this.pending) {
        this.pending.release();
        this.pending = undefined;
      }
      const journal = await BackupRestoreJournal.active(this.store()).catch(() => undefined);
      if (journal && !settled(journal.state.phase)) setRestoreRecoveryRequired(true);
      if (error instanceof ConflictException || error instanceof NotFoundException) throw error;
      if (error instanceof BackupRequirementError) throw new ConflictException(error.message);
      throw failed();
    } finally {
      release?.();
      this.abort = undefined;
      this.preparing = false;
    }
  }
  // Internal retained path: the caller owns the point-bound, single-use account grant.
  async prepareRetained(options: {
    importId: string;
    ownerId: number;
    binding: TimeMachineRestoreBinding;
    admitted: Awaited<ReturnType<TimeMachineStore['requireCoherentRuntime']>>;
    expectedRuntimeManifestSha256: string;
    admit: (journal: BackupRestoreJournal) => Promise<RetainedRestorePermit>;
  }) {
    if (
      !uuid.test(options.importId) ||
      !/^[a-f0-9]{64}$/.test(options.expectedRuntimeManifestSha256) ||
      options.admitted.manifest.pointId !== options.binding.pointId ||
      options.admitted.manifest.legacy.manifestSha256 !== options.binding.manifestSha256 ||
      options.admitted.manifest.legacy.cipherSha256 !== options.binding.archiveSha256 ||
      !(
        (options.admitted.manifest.schema === 'orbis.time-machine-runtime.v3' && options.admitted.controllerAuthority.metadata.version === 1) ||
        (options.admitted.manifest.schema === 'orbis.time-machine-runtime.v4' && options.admitted.controllerAuthority.metadata.version === 2) ||
        (options.admitted.manifest.schema === 'orbis.time-machine-runtime.v6' && options.admitted.controllerAuthority.metadata.version === 4)
      )
    )
      throw failed();
    await this.prepareStartup();
    if (this.preparing || this.pending || backupMaintenanceActive() || installationMode().phase !== 'normal')
      throw new ConflictException('Finish the current operation or restore recovery before starting another restore.');
    this.preparing = true;
    const abort = new AbortController();
    this.abort = abort;
    let release: (() => void) | undefined;
    try {
      release = await acquireBackupMaintenance(abort.signal);
      if ((await this.tasks.read()).tasks.some((task) => ['queued', 'running', 'unconfirmed'].includes(task.status)))
        throw new ConflictException('Wait for app tasks to finish before restoring.');
      const host = await this.host.status();
      if ((host.enrolled && !host.available) || (host.job && ['queued', 'running', 'recovering', 'interrupted'].includes(host.job.state)))
        throw new ConflictException('Finish the server update or recovery before restoring.');
      const apps = await this.apps.getApps();
      if (apps.some((app) => !['running', 'stopped', 'missing'].includes(app.status)))
        throw new ConflictException('Wait for apps to reach a stable state before restoring.');
      await cleanupSettledRestoreAuxiliaries({
        docker: this.docker,
        store: this.store(),
        controller: os.hostname(),
        data: this.directories().data,
        signal: abort.signal,
      });
      const plan = await this.runtime.plan(apps.map((app) => `${app.appName}_${app.appStoreSlug}`));
      if (
        apps.some(
          (app) => app.status === 'running' && !plan.containers.some((container) => container.project === `${app.appName}_${app.appStoreSlug}`),
        )
      )
        throw new ConflictException('A running app could not be identified. Refresh Apps before restoring.');
      const database = this.config.get('database');
      const result = await prepareRestoreHandoff({
        docker: this.docker,
        controller: os.hostname(),
        ownerId: options.ownerId,
        connection: { host: database.host, port: database.port, user: database.username, password: database.password, database: database.database },
        queue: this.config.get('queue'),
        apps: plan.containers.map((container) => ({ id: container.id, project: container.project })),
        directories: this.directories(),
        signal: abort.signal,
        preserveLiveProxy:
          (options.admitted.manifest.schema === 'orbis.time-machine-runtime.v4' && options.admitted.controllerAuthority.metadata.version === 2) ||
          (options.admitted.manifest.schema === 'orbis.time-machine-runtime.v6' && options.admitted.controllerAuthority.metadata.version === 4),
        claimReviewedSource: async (journal, accept) => {
          const permit = await options.admit(journal);
          await this.imports.claimRetainedSource(options.importId, options.ownerId, options.binding, permit, {
            journal,
            signal: abort.signal,
            prepare: async (source, signal) => {
              await accept(source, signal);
              await stageRetainedRuntime({
                journal,
                source,
                admitted: options.admitted,
                expectedManifestSha256: options.expectedRuntimeManifestSha256,
                signal,
              });
            },
          });
        },
      });
      setRestoreRecoveryRequired(true);
      this.pending = { id: result.journal.state.id, release };
      release = undefined;
      return result.journal;
    } catch (error) {
      const journal = await BackupRestoreJournal.active(this.store()).catch(() => undefined);
      if (journal && !settled(journal.state.phase)) setRestoreRecoveryRequired(true);
      if (error instanceof ConflictException || error instanceof NotFoundException) throw error;
      if (error instanceof BackupRequirementError) throw new ConflictException(error.message);
      throw failed();
    } finally {
      release?.();
      this.abort = undefined;
      this.preparing = false;
    }
  }
  async retainedStatus(journal: BackupRestoreJournal, ownerId: number) {
    const receipt = await readRetainedRestoreReceipt(journal);
    if (!receipt || receipt.ownerId !== ownerId) throw failed();
    const transaction = await RetainedRootTransaction.read(journal.directory);
    const signal = AbortSignal.timeout(5000);
    const [status, admission] = await Promise.all([
      transaction.status(signal),
      readRetainedBoundRecord(path.join(journal.directory, 'time-machine-admission.json')),
    ]);
    if (status.pointId !== receipt.binding.pointId || status.admissionSha256 !== admission.sha256) throw failed();
    const maintenance = await readRootRestorationState();
    const terminal = status.state === 'complete' || status.state === 'rolled-back';
    const finished =
      maintenance === 'idle' &&
      ((status.state === 'complete' && status.decision === 'commit') || (status.state === 'rolled-back' && status.decision === 'rollback'));
    if (finished && status.state === 'rolled-back' && status.decision === 'rollback') {
      const active = await BackupRestoreJournal.active(this.store());
      const state = active?.state.id === journal.state.id ? await journal.refresh() : journal.state;
      if (state.phase === 'staging' && state.decision === null) await journal.discardStaging();
      else if (!['rolled-back', 'discarded'].includes(state.phase)) throw failed();
    }
    if (finished && this.pending?.id === journal.state.id) {
      this.pending.release();
      this.pending = undefined;
    }
    if (finished && !this.pending) {
      this.startupHeld = false;
      this.recoveryHold = undefined;
      setRestoreRecoveryRequired(false);
    }
    const recovery = maintenance === 'recovery' || (maintenance === 'checking' && terminal);
    const checking = maintenance === null || maintenance === 'checking';
    const jobStatus = finished ? (status.state === 'complete' ? 'succeeded' : 'rolled-back') : recovery ? 'recovery-required' : 'running';
    return {
      job: {
        id: journal.state.id,
        status: jobStatus,
        phase: status.state,
        stage: finished ? 'complete' : recovery ? 'recovering' : status.state,
        message: finished
          ? status.state === 'complete'
            ? 'The restored server is ready.'
            : 'The original server was recovered.'
          : recovery
            ? 'Restore recovery needs review.'
            : 'Restoring configuration and app data.',
        needsRecovery: recovery,
        progressUnavailable: checking,
        canCancel: false,
        canRecover: recovery && (status.recoverable || terminal),
      },
    };
  }

  // The durable root transaction owns recovery after begin is attempted, including a lost reply.
  async beginRetainedRoot(options: {
    journal: BackupRestoreJournal;
    importId: string;
    ownerId: number;
    binding: TimeMachineRestoreBinding;
    admitted: Awaited<ReturnType<TimeMachineStore['requireCoherentRuntime']>>;
    expectedRuntimeManifestSha256: string;
    verifyAccount: () => Promise<void>;
    signal: AbortSignal;
  }) {
    const { journal, binding, admitted, signal } = options;
    if (
      !this.pending ||
      this.pending.id !== journal.state.id ||
      binding.pointId !== admitted.manifest.pointId ||
      binding.archiveSha256 !== admitted.manifest.legacy.cipherSha256 ||
      binding.manifestSha256 !== admitted.manifest.legacy.manifestSha256
    )
      throw failed();
    let beginPrepared = false;
    try {
      await options.verifyAccount();
      const review = await reviewRetainedRoot({ pointId: binding.pointId, restoreId: journal.state.id, importId: options.importId, signal });
      const authority = admitted.controllerAuthority.metadata;
      const platform = retainedPlatformSchema(authority.platform);
      if (platform instanceof type.errors || canonicalRuntimeJson(review.publication) !== canonicalRuntimeJson(authority.publication)) throw failed();
      const target = {
        publication: review.publication,
        creationReference: authority.archive.creationReference,
        platform,
        platformManifestDigest: authority.archive.platformManifestDigest,
        configDigest: authority.archive.configDigest,
      };
      await options.verifyAccount();
      const transaction = await RetainedRootTransaction.create(journal.directory, review);
      beginPrepared = true;
      const allocation = await transaction.begin(signal);
      if (allocation.state !== 'allocated' || !allocation.binding) throw failed();
      await bindRetainedJournal({
        store: this.store(),
        restoreId: journal.state.id,
        nonce: journal.state.nonce,
        pointId: binding.pointId,
        ownerId: options.ownerId,
        importId: options.importId,
        expectedTarget: target,
        expectedRuntimeManifestSha256: options.expectedRuntimeManifestSha256,
        rootStatus: () => transaction.status(signal),
        verifyRootWorker: (rootBinding) => verifyRetainedRootWorker({ journal, rootBinding, docker: this.docker }),
      });
      await options.verifyAccount();
      await transaction.launch('activate', signal);
      const pending = this.pending;
      if (!pending || pending.id !== journal.state.id) throw failed();
      this.pending = undefined;
      pending.release();
      return await this.retainedStatus(journal, options.ownerId);
    } catch (error) {
      if (!beginPrepared && this.pending?.id === journal.state.id) {
        try {
          await discardUnstartedRestoreHandoff(this.docker, journal);
          await fs.rm(path.join(journal.directory, 'retained'), { recursive: true, force: true });
          await fs.rm(path.join(journal.directory, 'retained-root-request.json'), { force: true });
          const directory = await fs.open(journal.directory, 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
          this.pending.release();
          this.pending = undefined;
          setRestoreRecoveryRequired(false);
        } catch {
          setRestoreRecoveryRequired(true);
        }
      } else {
        setRestoreRecoveryRequired(true);
        if (beginPrepared) this.watchRetainedTerminal(journal, options.ownerId);
      }
      if (error instanceof ConflictException || error instanceof NotFoundException) throw error;
      throw failed();
    }
  }
  // Root's protected admission digest authenticates ownership even during incomplete allocation.
  async recoverRetainedRoot(options: {
    restoreId: string;
    pointId: string;
    ownerId: number;
    binding: TimeMachineRestoreBinding;
    verifyAccount: () => Promise<void>;
    signal: AbortSignal;
  }) {
    if (
      !uuid.test(options.restoreId) ||
      !uuid.test(options.pointId) ||
      options.binding.pointId !== options.pointId ||
      this.preparing ||
      this.recoveringRetained
    )
      throw failed();
    this.recoveringRetained = true;
    try {
      await this.prepareStartup();
      await options.verifyAccount();
      const journal = await BackupRestoreJournal.active(this.store());
      if (!journal || journal.state.id !== options.restoreId) throw failed();
      const receipt = await readRetainedRestoreReceipt(journal);
      if (
        !receipt ||
        receipt.ownerId !== options.ownerId ||
        receipt.binding.pointId !== options.pointId ||
        canonicalRuntimeJson(receipt.binding) !== canonicalRuntimeJson(options.binding)
      )
        throw failed();
      const transaction = await RetainedRootTransaction.read(journal.directory);
      const admission = await readRetainedBoundRecord(path.join(journal.directory, 'time-machine-admission.json'));
      let absent = false;
      try {
        const status = await transaction.status(options.signal);
        if (status.pointId !== options.pointId || status.admissionSha256 !== admission.sha256) throw failed();
      } catch {
        const proof = await transaction.revokeAbsent(options.signal);
        if (proof.admissionSha256 !== admission.sha256) throw failed();
        absent = true;
      }
      if (this.pending && this.pending.id !== options.restoreId) throw failed();
      if (!this.pending) {
        const release = await acquireBackupMaintenance(options.signal);
        this.pending = { id: options.restoreId, release };
      }
      setRestoreRecoveryRequired(true);
      try {
        await options.verifyAccount();
        if (absent) {
          await discardUnstartedRestoreHandoff(this.docker, journal);
          await fs.rm(path.join(journal.directory, 'retained'), { recursive: true, force: true });
          await fs.rm(path.join(journal.directory, 'retained-root-request.json'), { force: true });
          const directory = await fs.open(journal.directory, 'r');
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } else await transaction.launch('recover', options.signal);
        const pending = this.pending;
        if (!pending || pending.id !== options.restoreId) throw failed();
        this.pending = undefined;
        pending.release();
        if (absent) {
          this.startupHeld = false;
          setRestoreRecoveryRequired(false);
        }
        return { restoreId: options.restoreId };
      } catch (error) {
        setRestoreRecoveryRequired(true);
        throw error;
      }
    } finally {
      this.recoveringRetained = false;
    }
  }
  async cancel(id: string, ownerId: number, credentials: Credentials) {
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    if (this.preparing) throw new ConflictException('Wait for restore preparation to finish before cancelling.');
    const journal = await this.active(id);
    if (await this.isRetainedJournal(journal)) throw new ConflictException('Use protected restore recovery for this operation.');
    if (settled(journal.state.phase) || journal.state.decision === 'commit')
      throw new ConflictException('This restore is finishing or already settled.');
    await this.ownController(journal);
    await readRestoreBootstrap(journal);
    await requestRestoreCancellation(journal);
    return this.status();
  }
  async recover(id: string, ownerId: number, credentials: Credentials, request?: Request) {
    const actor = request ? await this.auth.operatorActionContext(request) : undefined;
    if (actor && actor.userId !== ownerId) throw failed();
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    await this.prepareStartup();
    if (this.preparing) throw new ConflictException('Wait for restore preparation to finish before recovering.');
    const journal = await this.active(id);
    if (await this.isRetainedJournal(journal)) {
      if (!request || !actor) throw failed();
      const receipt = await readRetainedRestoreReceipt(journal);
      if (!receipt || receipt.ownerId !== ownerId) throw failed();
      const pointStore = new TimeMachineStore(this.directories().data);
      const point = await pointStore.load(receipt.binding.pointId);
      if (point.ownerId !== ownerId) throw failed();
      const metadata = await pointStore.metadata(point);
      if (
        metadata.archiveSha256 !== receipt.binding.archiveSha256 ||
        metadata.manifestSha256 !== receipt.binding.manifestSha256 ||
        (await pointStore.machineIdentity()) !== receipt.binding.machineId
      )
        throw failed();
      const verifyAccount = async () => {
        const current = await this.auth.operatorActionContext(request);
        if (current.userId !== actor.userId || current.sessionBinding !== actor.sessionBinding || current.securityBinding !== actor.securityBinding)
          throw failed();
      };
      await this.recoverRetainedRoot({
        restoreId: id,
        pointId: receipt.binding.pointId,
        ownerId,
        binding: receipt.binding,
        verifyAccount,
        signal: AbortSignal.timeout(15 * 60_000),
      });
      return { ...(await this.status()), rootManaged: true as const };
    }
    const current = await this.ownController(journal);
    let progress: Awaited<ReturnType<typeof readRestoreProgress>>;
    try {
      progress = await readRestoreProgress(journal);
    } catch {
      throw failed();
    }
    if (settled(journal.state.phase)) {
      if (matchingOutcome(journal.state.phase, progress?.status) || (await this.inertDiscard(journal))) {
        if (this.startupHeld) this.restart = { id, controller: snapshotRestoreContainer(current) };
        return this.status();
      }
      if (journal.state.phase === 'completed') throw failed();
      try {
        await this.recoveryWorker(journal);
      } catch {
        throw failed();
      }
      this.holdRecovery(journal);
      return this.status();
    }
    try {
      await readRestoreBootstrap(journal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || journal.state.phase !== 'staging') throw failed();
      await discardUnstartedRestoreHandoff(this.docker, journal);
      if (this.startupHeld) this.restart = { id, controller: snapshotRestoreContainer(current) };
      else setRestoreRecoveryRequired(false);
      return this.status();
    }
    this.holdRecovery(journal);
    return this.status();
  }
  // Called once after the authorized response is flushed, never while serializing it.
  launch(id: string) {
    const existing = this.launches.get(id);
    if (existing) return existing;
    const launch = this.startWorker(id).finally(() => this.launches.delete(id));
    this.launches.set(id, launch);
    return launch;
  }
  private async startWorker(id: string) {
    try {
      const journal = await this.active(id);
      if (this.restart?.id === id) {
        const current = await this.ownController(journal);
        if (snapshotRestoreContainer(current).fingerprint !== this.restart.controller.fingerprint) throw failed();
        await this.docker.getContainer(current.Id).restart({ t: 30 });
        return;
      }
      const progress = await readRestoreProgress(journal);
      if (settled(journal.state.phase)) {
        if (matchingOutcome(journal.state.phase, progress?.status) || (await this.inertDiscard(journal))) return;
        if (journal.state.phase === 'completed') throw failed();
      }
      const worker = await this.recoveryWorker(journal);
      this.holdRecovery(journal);
      if (!worker.State.Running && !worker.State.Restarting) await this.docker.getContainer(worker.Id).start();
    } catch {
      if (this.restart?.id === id) this.restart = undefined;
      setRestoreRecoveryRequired(true);
      this.logger.warn('Restore worker could not be started safely. Review restore recovery.');
    } finally {
      if (this.pending?.id === id) {
        this.pending.release();
        this.pending = undefined;
      }
    }
  }
}
