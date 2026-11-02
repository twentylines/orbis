import { snapshotAppIcons } from './time-machine-app-icons';
import { readTimeMachineStorage } from './time-machine-storage';
import fs from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { hashCaptureSnapshotFile } from './time-machine-capture-coherence';
import { captureHasControllerVersion, versionMatchesControllerAuthority } from './time-machine-controller-version';
import { verifyCaptureAgainstBackup } from './backup-image-capture';
import { Injectable, NotFoundException, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  timeMachineCaptureSchema,
  timeMachinePreferencesUpdateSchema,
  timeMachineHashSchema,
  timeMachineIdSchema,
  type TimeMachineList,
  type TimeMachinePoint,
  type TimeMachineMetadata,
} from '@runtipi/common/schemas/time-machine';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import { AuthService } from '../auth/auth.service';
import { AccountSecurityService } from '../auth/account-security.service';
import { authorizeBackupActionSession } from './backup-session-authorization';
import { ResetState } from '../system-reset/reset-state';
import { backupCredentials } from './backup-access';
import { SystemBackupsService } from './system-backups.service';
import { TimeMachineStore, type StoredTimeMachinePoint, type TimeMachineDraftMetadata } from './time-machine-store';
import { historicalHomePreview, captureBreakdown } from './time-machine-preview';
import { timeMachineCapabilities, timeMachineConflict, timeMachineIssue, timeMachineRestoreBlockers } from './time-machine-policy';
import { restoreStartupRole } from './backup-restore-startup';
import { snapshotWallpaper } from './time-machine-assets';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Request } from 'express';
import { backupMaintenanceActive } from '@/common/backup-maintenance';
import { installationMode } from '@/common/installation-mode';
import { DockerService } from '../docker/docker.service';
import { DesktopPreferencesService } from '../desktop-preferences/desktop-preferences.service';
import { BackupImportsService } from './backup-imports.service';
import { TimeMachineRestoreAuthorization } from './time-machine-restore-authorization';
import { BackupRestoresService } from './backup-restores.service';
import { BackupRestoreJournal } from './backup-restore-journal';
import { readRetainedRestoreReceipt } from './time-machine-restore-admission';
import { TimeMachineCaptureRuntime } from './time-machine-capture-runtime';
import { createV6SealAdmission } from './time-machine-v6-seal-admission';
import type { CapturedRuntimeInput } from './time-machine-runtime-payload';
import { restoreConflict, restoreIssue } from './time-machine-restore-policy';
import {
  timeMachineRestoreReviewResponseSchema,
  timeMachineRestorePasskeyOptionsSchema,
  type TimeMachineRestoreBinding,
  type TimeMachineRestoreReview,
} from '@runtipi/common/schemas/time-machine-restore';

type Credentials = { password: string; totpCode?: string };
type LocalReview = {
  ownerId: number;
  value: TimeMachineRestoreReview;
  importId: string | null;
  importExpiresAt: number | null;
  restoreContractSha256?: string;
  abort: AbortController;
  done: Promise<void>;
};
@Injectable()
export class TimeMachineService implements OnModuleInit, OnModuleDestroy {
  private readonly dataDirectory: string;
  private store: TimeMachineStore;
  private readonly restoreDirectory: string;
  private ready?: Promise<void>;
  private unavailable = false;
  private closing = false;
  private readonly reviews = new Map<string, LocalReview>();
  private reviewing?: LocalReview;
  private openingAssets = 0;
  private exporting?: { abort: AbortController; done: Promise<void> };
  private removing = false;
  private readonly captureSecurity: AccountSecurityService;
  private active?: {
    id: string;
    ownerId: number;
    abort: AbortController;
    done: Promise<void>;
    backupJobId: string | null;
    setup: Promise<void>;
    setupDone: () => void;
    settle: () => void;
    started: boolean;
    onboarding?: boolean;
    start?: () => Promise<void>;
    progress?: { stage: string; completedBytes: number; totalBytes: number | null };
  };
  constructor(
    config: ConfigurationService,
    private readonly backups: SystemBackupsService,
    private readonly auth: AuthService,
    private readonly logger: LoggerService,
    private readonly imports: BackupImportsService,
    private readonly authorization: TimeMachineRestoreAuthorization,
    private readonly docker: DockerService,
    private readonly restores: BackupRestoresService,
    private readonly captureRuntime: TimeMachineCaptureRuntime,
    @Optional() private readonly onboarding?: DesktopPreferencesService,
    @Optional() security?: AccountSecurityService,
  ) {
    this.dataDirectory = config.get('directories').dataDir;
    this.captureSecurity = security ?? new AccountSecurityService(config);
    this.store = new TimeMachineStore(config.get('directories').dataDir);
    this.restoreDirectory = path.join(config.get('directories').dataDir, 'backups', 'restores');
  }
  onModuleInit() {
    if (restoreStartupRole() === 'verify') return;
    return this.initialize();
  }
  async onModuleDestroy() {
    this.closing = true;
    const active = this.active;
    const review = this.reviewing;
    const exporting = this.exporting;
    exporting?.abort.abort();
    review?.abort.abort();
    active?.abort.abort();
    if (active?.backupJobId) await this.backups.cancel(active.backupJobId, active.ownerId).catch(() => undefined);
    await active?.setup;
    if (active && !active.started) {
      if (active.id)
        await this.store.fail(await this.store.load(active.id), 'capture-interrupted').catch(() => {
          this.unavailable = true;
        });
      if (this.active === active) this.active = undefined;
      active.settle();
    }
    await active?.done;
    await review?.done;
    await exporting?.done;
  }
  private initialize() {
    this.ready ??= this.load();
    return this.ready;
  }
  private async load() {
    try {
      const points = await this.store.list();
      for (const point of points)
        if (point.status === 'capturing') await this.store.update({ ...point, status: 'interrupted', issue: 'capture-interrupted' });
      await this.captureRuntime.recoverCaptureFences(points);
      await this.store.preferences();
    } catch {
      this.unavailable = true;
      this.logger.warn('Time Machine storage needs review. Capture is disabled.');
    }
  }
  private available() {
    if (this.closing || this.unavailable) throw timeMachineConflict('storage-unavailable');
  }
  capabilities() {
    return timeMachineCapabilities();
  }
  storage() {
    return readTimeMachineStorage(this.dataDirectory, () => this.store.list());
  }
  async preferences() {
    await this.initialize();
    this.available();
    return this.store.preferences();
  }
  async updatePreferences(input: unknown) {
    await this.initialize();
    this.available();
    if (!timeMachinePreferencesUpdateSchema.allows(input)) throw timeMachineConflict('invalid-request');
    if (this.active || this.reviewing || this.exporting || this.removing) throw timeMachineConflict('operation-busy');
    return this.store.updatePreferences(input);
  }
  private async publicPoint(point: StoredTimeMachinePoint): Promise<TimeMachinePoint> {
    let metadata: TimeMachinePoint['metadata'] = null;
    if (point.status === 'sealed') {
      metadata = await this.store.metadata(point);
    }
    const progress =
      this.active?.id === point.id && this.active.progress
        ? this.active.progress
        : this.active?.id === point.id && point.backupJobId
          ? (await this.backups.list(point.ownerId)).jobs.find((job) => job.id === point.backupJobId)
          : undefined;
    return {
      id: point.id,
      createdAt: point.createdAt,
      status: point.status,
      stage: progress?.stage ?? (point.status === 'sealed' ? 'complete' : 'preparing'),
      completedBytes: progress?.completedBytes ?? 0,
      totalBytes: progress?.totalBytes ?? null,
      issue: point.issue ? timeMachineIssue(point.issue) : null,
      backupJobId: point.backupJobId,
      metadata,
    };
  }
  async list(ownerId: number): Promise<TimeMachineList> {
    await this.initialize();
    if (this.unavailable) return { version: 1, available: false, points: [], activeCaptureId: null };
    try {
      const reset = await new ResetState(this.dataDirectory).active();
      const points = (await this.store.list()).filter(
        (point) =>
          point.ownerId === ownerId &&
          (reset?.phase !== 'complete' ||
            point.createdAt >= reset.createdAt ||
            point.status === 'capturing' ||
            point.status === 'interrupted' ||
            point.id === this.active?.id),
      );
      return {
        version: 1,
        available: true,
        points: await Promise.all(points.map((point) => this.publicPoint(point))),
        activeCaptureId: this.active?.id || null,
      };
    } catch {
      throw timeMachineConflict('storage-unavailable');
    }
  }
  async activity(ownerId: number) {
    await this.initialize();
    this.available();
    const active = this.active;
    if (!active?.id || active.ownerId !== ownerId) return { version: 1 as const, point: null };
    const point = await this.store.load(active.id);
    if (point.ownerId !== ownerId || point.status !== 'capturing') return { version: 1 as const, point: null };
    return { version: 1 as const, point: await this.publicPoint(point) };
  }
  private async owned(id: string, ownerId: number) {
    try {
      const point = await this.store.load(id);
      if (point.ownerId !== ownerId) throw timeMachineConflict('point-not-found');
      return point;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw timeMachineConflict('point-not-found');
      throw error;
    }
  }
  async inspect(id: string, ownerId: number) {
    await this.initialize();
    this.available();
    try {
      return await this.publicPoint(await this.owned(id, ownerId));
    } catch (error) {
      if (error && typeof error === 'object' && 'getResponse' in error) throw error;
      throw timeMachineConflict('point-integrity-failed');
    }
  }
  async onboardingCapture(id: string, ownerId: number) {
    await this.initialize();
    this.available();
    if (!timeMachineIdSchema.allows(id)) throw timeMachineConflict('invalid-request');
    if (this.active?.onboarding && this.active.id === id && this.active.ownerId === ownerId) await this.active.setup;
    let attempt: Awaited<ReturnType<TimeMachineStore['onboardingAttempt']>>;
    try {
      attempt = await this.store.onboardingAttempt(id, ownerId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw timeMachineConflict('point-not-found');
      throw error;
    }
    let point: StoredTimeMachinePoint;
    try {
      point = await this.store.load(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw timeMachineConflict('capture-recovery-required');
      throw error;
    }
    if (point.ownerId !== ownerId || point.version !== 2 || point.onboardingAttemptId !== id) throw timeMachineConflict('point-not-found');
    if (
      point.status === 'capturing' &&
      (attempt.state !== 'ready' || !this.active?.onboarding || this.active.id !== id || this.active.ownerId !== ownerId)
    )
      throw timeMachineConflict('capture-recovery-required');
    return this.publicPoint(point);
  }

  async capture(ownerId: number, credentials: unknown, request: unknown) {
    await this.initialize();
    this.available();
    if (!timeMachineCaptureSchema.allows(request)) {
      throw timeMachineConflict('invalid-request');
    }
    if ((await this.captureSecurity.read(ownerId)).requireCaptureAuthentication) {
      const proof = backupCredentials(credentials);
      await this.auth.verifySensitiveAction(ownerId, proof.password, proof.totpCode);
    }
    return this.prepareCapture(ownerId, request);
  }

  async beginOnboardingCapture(ownerId: number, id: unknown, label: unknown) {
    await this.initialize();
    this.available();
    const request = { label, experimentalAcknowledged: true };
    if (!timeMachineIdSchema.allows(id) || !timeMachineCaptureSchema.allows(request) || !this.onboarding)
      throw timeMachineConflict('invalid-request');
    if (this.active?.onboarding && this.active.id === id && this.active.ownerId === ownerId) {
      await this.active.setup;
      return this.onboardingCapture(id, ownerId);
    }
    try {
      await this.store.onboardingAttempt(id, ownerId);
      return this.onboardingCapture(id, ownerId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const result = await this.onboarding.withIncompleteOnboarding(ownerId, (complete) => this.prepareCapture(ownerId, request, id, complete));
    if (!result) {
      try {
        await this.store.onboardingAttempt(id, ownerId);
        return this.onboardingCapture(id, ownerId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw timeMachineConflict('invalid-request');
        throw error;
      }
    }
    return result.value;
  }

  private async prepareCapture(
    ownerId: number,
    request: typeof timeMachineCaptureSchema.infer,
    onboardingAttemptId?: string,
    completeOnboarding?: () => Promise<void>,
  ) {
    if (onboardingAttemptId !== undefined) {
      if (!timeMachineIdSchema.allows(onboardingAttemptId) || !this.onboarding) throw timeMachineConflict('invalid-request');
      if (this.active?.onboarding && this.active.id === onboardingAttemptId && this.active.ownerId === ownerId) {
        await this.active.setup;
        return this.onboardingCapture(onboardingAttemptId, ownerId);
      }
      try {
        await this.store.onboardingAttempt(onboardingAttemptId, ownerId);
        return this.onboardingCapture(onboardingAttemptId, ownerId);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const captureSelection = onboardingAttemptId
      ? await this.captureRuntime.requireSupport(undefined, true)
      : await this.captureRuntime.requireSupport();
    await this.docker.requireNoPendingAppImageUpdates().catch(() => {
      throw timeMachineConflict('capture-recovery-required');
    });
    this.available();
    if (onboardingAttemptId && this.active?.onboarding && this.active.id === onboardingAttemptId && this.active.ownerId === ownerId) {
      await this.active.setup;
      return this.onboardingCapture(onboardingAttemptId, ownerId);
    }
    if (this.active || this.reviewing || this.exporting || this.removing) throw timeMachineConflict('operation-busy');
    let settle: () => void = () => undefined;
    let setupDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const setup = new Promise<void>((resolve) => {
      setupDone = resolve;
    });
    const active: NonNullable<TimeMachineService['active']> = {
      id: onboardingAttemptId ?? '',
      ownerId,
      ...(onboardingAttemptId ? { onboarding: true } : {}),
      abort: new AbortController(),
      done,
      setup,
      setupDone,
      settle,
      started: false,
      backupJobId: null,
    };
    this.active = active;
    let point: StoredTimeMachinePoint | undefined;
    let attemptClaimed = false;
    try {
      const preferences = await this.store.preferences();
      if (!preferences.enabled) throw timeMachineConflict('invalid-request');
      if (preferences.excludedApps.length) throw timeMachineConflict('app-exclusions-unsupported');
      if ((await this.store.list()).some((item) => item.status === 'interrupted')) throw timeMachineConflict('capture-recovery-required');
      if (onboardingAttemptId) {
        attemptClaimed = (await this.store.onboardingAttempt(onboardingAttemptId, ownerId, true)).claimed;
        if (!attemptClaimed) {
          if (this.active === active) this.active = undefined;
          settle();
          return await this.onboardingCapture(onboardingAttemptId, ownerId);
        }
      }
      const created = await this.store.create(ownerId, 2, onboardingAttemptId);
      point = created.point;
      active.id = point.id;
      active.abort.signal.throwIfAborted();
      const captured = point;
      active.start = () => this.runCapture(active, captured, created.passphrase, request.label, captureSelection);
      if (onboardingAttemptId) {
        await completeOnboarding?.();
        await this.store.readyOnboardingAttempt(onboardingAttemptId, ownerId);
      }
      return await this.publicPoint(point);
    } catch (error) {
      active.abort.abort();
      if (attemptClaimed && !point) this.unavailable = true;
      if (point)
        await this.store.fail(point, 'capture-failed').catch(() => {
          this.unavailable = true;
        });
      if (this.active === active) this.active = undefined;
      settle();
      if (error && typeof error === 'object' && 'getResponse' in error) throw error;
      throw timeMachineConflict('capture-failed');
    } finally {
      setupDone();
    }
  }
  launchCapture(id: string, ownerId: number) {
    const active = this.active;
    if (!active || active.id !== id || active.ownerId !== ownerId || active.started || this.closing || !active.start)
      return active?.done ?? Promise.resolve();
    active.started = true;
    void active.start().finally(() => {
      active.start = undefined;
      if (this.active === active) this.active = undefined;
      active.settle();
    });
    return active.done;
  }
  async cancelCapture(id: string, ownerId: number) {
    await this.owned(id, ownerId);
    const active = this.active;
    if (!active || active.id !== id || active.ownerId !== ownerId) throw timeMachineConflict('operation-busy');
    active.abort.abort();
    await active.setup;
    if (!active.started) {
      await this.store.fail(await this.store.load(id), 'capture-interrupted');
      if (this.active === active) this.active = undefined;
      active.settle();
    }
    await active.done;
    return this.publicPoint(await this.store.load(id));
  }
  private async runCapture(
    active: NonNullable<TimeMachineService['active']>,
    point: StoredTimeMachinePoint,
    passphrase: string,
    label: string,
    selection: object,
  ) {
    const signal = active.abort.signal;
    const progress = (stage: string, completedBytes: number, totalBytes: number | null) => {
      active.progress = stage ? { stage, completedBytes, totalBytes } : undefined;
    };
    let operation: ReturnType<TimeMachineCaptureRuntime['operation']> | undefined;
    try {
      operation = this.captureRuntime.operation(point.id, signal, progress, selection);
      const preparedOperation = operation;
      signal.throwIfAborted();
      let metadata: TimeMachineDraftMetadata | undefined;
      let runtime: CapturedRuntimeInput | undefined;
      const job = await this.backups.startLocalCapture(
        point.ownerId,
        passphrase,
        async (snapshot) => {
          runtime = await preparedOperation.finalize(snapshot);
          const preview = await historicalHomePreview(snapshot, point.ownerId);
          const wallpaper = await snapshotWallpaper(snapshot, preview, point.ownerId);
          const savedWallpaper = wallpaper ? await this.store.retainWallpaper(point, wallpaper, signal) : null;
          const icons = preview.available ? await snapshotAppIcons(snapshot, signal) : null;
          const savedIcons = icons ? await this.store.retainAppIcons(point, icons, signal) : null;
          metadata = {
            version: 2,
            id: point.id,
            createdAt: point.createdAt,
            label,
            source: 'manual',
            manifestSha256: snapshot.manifestSha256,
            software: snapshot.software,
            coverage: {
              database: true,
              configuration: true,
              appData: true,
              dockerImages: true,
              controllerConfiguration: true,
              controllerVersion: captureHasControllerVersion(snapshot.software.orbis, runtime),
              appearance: true,
              cluster: 'local-only',
            },
            restore: { ready: false, blockers: timeMachineRestoreBlockers().filter((issue) => issue.code !== 'docker-images-not-retained') },
            preview: preview.available
              ? {
                  ...preview,
                  ...(savedWallpaper
                    ? { wallpaperAsset: savedWallpaper, customWallpaperAvailable: savedWallpaper.source === 'captured-custom' }
                    : {}),
                  ...(savedIcons ? { appIcons: savedIcons } : {}),
                }
              : preview,
            breakdown: captureBreakdown(snapshot),
            excludedApps: [],
          };
        },
        operation,
      );
      active.backupJobId = job.id;
      point.backupJobId = job.id;
      void job.ready.catch(() => undefined);
      signal.throwIfAborted();
      await this.store.update(point);
      await this.finish(
        point,
        job.ready,
        () => metadata,
        signal,
        () => runtime,
        (completed, total) => progress('encrypting', completed, total),
        passphrase,
      );
    } catch {
      if (active.backupJobId) await this.backups.cancel(active.backupJobId, point.ownerId).catch(() => undefined);
      await this.store.fail(point, signal.aborted ? 'capture-interrupted' : 'capture-failed').catch(() => {
        this.unavailable = true;
      });
      this.logger.warn('Time Machine capture did not finish. Review its backup recovery state before retrying.');
    } finally {
      await operation?.dispose().catch(() => {
        this.unavailable = true;
        this.logger.warn('Time Machine staging cleanup needs review.');
      });
    }
  }
  private async finish(
    point: StoredTimeMachinePoint,
    ready: Awaited<ReturnType<SystemBackupsService['startLocalCapture']>>['ready'],
    metadata: () => TimeMachineDraftMetadata | undefined,
    signal: AbortSignal,
    runtime: () => CapturedRuntimeInput | undefined,
    progress: (completed: number, total: number) => void,
    passphrase: string,
  ) {
    try {
      const archive = await ready;
      const snapshot = metadata();
      if (!snapshot) {
        archive.stream.destroy();
        throw timeMachineConflict('capture-failed');
      }
      const input = runtime();
      if (!input) {
        archive.stream.destroy();
        throw timeMachineConflict('capture-failed');
      }
      let admission: ReturnType<typeof createV6SealAdmission> | undefined;
      try {
        admission = input.appRuntime
          ? createV6SealAdmission({
              input,
              pointId: point.id,
              ownerId: point.ownerId,
              bytes: archive.bytes,
              manifestSha256: snapshot.manifestSha256,
              passphrase,
              imports: this.imports,
              signal,
            })
          : undefined;
      } catch (error) {
        archive.stream.destroy();
        throw error;
      }
      await this.store.seal({ ...point, backupJobId: null }, archive.stream, archive.bytes, snapshot, signal, { input, admission, progress });
      if (point.backupJobId) await this.backups.remove(point.backupJobId, point.ownerId).catch(() => undefined);
    } catch {
      await this.store.fail(point, signal.aborted ? 'capture-interrupted' : 'capture-failed').catch(() => {
        this.unavailable = true;
      });
      this.logger.warn('A Time Machine capture did not seal. No restore point is ready for activation.');
    }
  }
  async remove(id: string, ownerId: number, credentials: Credentials) {
    await this.initialize();
    this.available();
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    return this.removeOwned(id, ownerId);
  }
  async removeForSession(id: string, ownerId: number, request: Request, credentials?: Credentials) {
    const actor = await authorizeBackupActionSession(this.auth, this.captureSecurity, request, ownerId, credentials);
    await this.initialize();
    this.available();
    await authorizeBackupActionSession(this.auth, this.captureSecurity, request, ownerId, credentials, 'backup', actor);
    return this.removeOwned(id, ownerId);
  }
  private async removeOwned(id: string, ownerId: number) {
    if (this.active || this.reviewing || this.exporting || this.removing) throw timeMachineConflict('operation-busy');
    this.removing = true;
    try {
      await this.owned(id, ownerId);
      const review = this.reviews.get(id);
      if (review?.importId)
        await this.imports.remove(review.importId, ownerId).catch((error) => {
          if (!(error instanceof NotFoundException)) throw error;
        });
      this.reviews.delete(id);
      return await this.store.remove(id, ownerId);
    } finally {
      this.removing = false;
    }
  }
  async restoreReview(id: string, ownerId: number) {
    await this.initialize();
    this.available();
    if (this.active || this.reviewing || this.exporting || this.removing || backupMaintenanceActive() || installationMode().phase !== 'normal')
      throw restoreConflict('operation-busy');
    const point = await this.owned(id, ownerId);
    const metadata = await this.store.metadata(point);
    const machineId = await this.store.machineIdentity(true);
    try {
      await this.docker.requireNoPendingAppImageUpdates();
    } catch {
      throw restoreConflict('restore-recovery-required');
    }
    if (this.active || this.reviewing || this.exporting || this.removing || backupMaintenanceActive()) throw restoreConflict('operation-busy');
    const previous = this.reviews.get(id);
    const review: LocalReview = {
      ownerId,
      importId: null,
      importExpiresAt: null,
      abort: new AbortController(),
      done: Promise.resolve(),
      value: {
        version: 1,
        pointId: id,
        reviewId: randomUUID(),
        archiveSha256: metadata.archiveSha256,
        manifestSha256: metadata.manifestSha256,
        machineId,
        status: 'reviewing',
        ready: false,
        expiresAt: null,
        blockers: [],
        progress: { stage: 'opening', completedBytes: 0, totalBytes: null },
      },
    };
    this.reviews.set(id, review);
    this.reviewing = review;
    review.done = this.finishReview(review, point, metadata, previous).finally(() => {
      if (this.reviewing === review) this.reviewing = undefined;
    });
    return timeMachineRestoreReviewResponseSchema.assert({ version: 1, review: structuredClone(review.value) });
  }
  private async finishReview(
    review: LocalReview,
    point: StoredTimeMachinePoint,
    metadata: NonNullable<TimeMachinePoint['metadata']>,
    previous?: LocalReview,
  ) {
    try {
      if (previous?.importId)
        await this.imports.remove(previous.importId, review.ownerId).catch((error) => {
          if (!(error instanceof NotFoundException)) throw error;
        });
      const runtime =
        point.version === 2
          ? await this.store.verifyRuntime(point, AbortSignal.any([review.abort.signal, AbortSignal.timeout(15 * 60_000)]))
          : undefined;
      const checked = await this.imports.reviewRetained(
        review.ownerId,
        { pointId: point.id, bytes: point.archiveBytes, archiveSha256: metadata.archiveSha256, manifestSha256: metadata.manifestSha256 },
        (signal, consume) => this.store.withArchive(point, signal, consume),
        AbortSignal.any([review.abort.signal, AbortSignal.timeout(15 * 60_000)]),
        (importId) => {
          review.importId = importId;
        },
        runtime
          ? async (content, signal) => {
              await verifyCaptureAgainstBackup({
                capture: runtime.capture,
                content,
                manifestSha256: metadata.manifestSha256,
                excludedApps: metadata.excludedApps,
                signal,
                ...(runtime.appRuntime ? { appRuntime: runtime.appRuntime } : {}),
              });
              if (runtime.coherence) {
                const database = await hashCaptureSnapshotFile(path.join(content, 'database.dump'), signal);
                if (database.bytes !== runtime.coherence.database.bytes || database.sha256 !== runtime.coherence.database.sha256)
                  throw timeMachineConflict('point-integrity-failed');
              }
            }
          : undefined,
        runtime?.appRuntime ?? undefined,
      );
      if (
        metadata.coverage.controllerVersion &&
        (!runtime?.coherence ||
          !versionMatchesControllerAuthority(metadata.software.orbis, runtime.controllerAuthority) ||
          checked.review.orbisVersion !== metadata.software.orbis)
      )
        throw timeMachineConflict('point-integrity-failed');
      const blockers = [];
      let provisional = false;
      if (runtime?.appRuntime && runtime.coherence && runtime.controllerAuthority?.metadata.version === 4) {
        try {
          const capability = await this.captureRuntime.requireV6RestoreCapability(review.abort.signal);
          review.restoreContractSha256 = capability.contractSha256;
          provisional = true;
        } catch {
          review.restoreContractSha256 = undefined;
        }
      }
      if (!provisional) blockers.push(restoreIssue('image-state-unavailable'));
      if (!metadata.coverage.controllerVersion) blockers.push(restoreIssue('controller-version-unsupported'));
      if (!checked.review.compatibility.compatible) blockers.push(restoreIssue('source-version-incompatible'));
      if (metadata.excludedApps.length) blockers.push(restoreIssue('excluded-apps-unsupported'));
      review.importExpiresAt = checked.expiresAt;
      review.value = {
        ...review.value,
        status: blockers.length ? 'blocked' : provisional ? 'eligible' : 'ready',
        ready: blockers.length === 0 && !provisional,
        expiresAt: blockers.length ? null : checked.expiresAt,
        blockers,
        progress: { stage: blockers.length || provisional ? 'checking' : 'ready', completedBytes: 0, totalBytes: null },
      };
    } catch (error) {
      const response = error && typeof error === 'object' && 'getResponse' in error ? (error as { getResponse(): unknown }).getResponse() : null;
      const integrity = response && typeof response === 'object' && 'code' in response && response.code === 'point-integrity-failed';
      review.value = {
        ...review.value,
        status: 'failed',
        ready: false,
        expiresAt: null,
        blockers: [restoreIssue(integrity ? 'point-integrity-failed' : 'restore-preparation-failed')],
        progress: { stage: 'failed', completedBytes: 0, totalBytes: null },
      };
      this.logger.warn('A retained restore point did not finish its file and database review. Activation remains disabled.');
    }
  }
  async readRestoreReview(id: string, ownerId: number) {
    await this.initialize();
    this.available();
    const point = await this.owned(id, ownerId);
    const metadata = await this.store.metadata(point);
    const review = this.reviews.get(id);
    if (!review) return timeMachineRestoreReviewResponseSchema.assert({ version: 1, review: null });
    if (review.ownerId !== ownerId) throw restoreConflict('point-not-found');
    if (
      review.value.archiveSha256 !== metadata.archiveSha256 ||
      review.value.manifestSha256 !== metadata.manifestSha256 ||
      review.value.machineId !== (await this.store.machineIdentity())
    )
      throw restoreConflict('point-integrity-failed');
    if (review.importId) {
      const job = await this.imports.retainedStatus(review.importId, ownerId).catch((error) => {
        if (error instanceof NotFoundException) return undefined;
        throw error;
      });
      if (review.value.status === 'reviewing' && job) {
        review.value.progress = {
          stage:
            job.stage === 'database' ? 'database' : job.stage === 'inspecting' ? 'inspecting' : job.stage === 'complete' ? 'checking' : 'opening',
          completedBytes: job.completedBytes,
          totalBytes: job.totalBytes,
        };
      } else if (
        review.importExpiresAt &&
        (review.importExpiresAt <= Date.now() || !job || job.status !== 'reviewed' || job.review?.manifestSha256 !== review.value.manifestSha256)
      ) {
        review.value = { ...review.value, status: 'blocked', ready: false, expiresAt: null, blockers: [restoreIssue('review-expired')] };
      }
    }
    return timeMachineRestoreReviewResponseSchema.assert({ version: 1, review: structuredClone(review.value) });
  }
  private async authorizationBinding(id: string, ownerId: number, reviewId: string): Promise<TimeMachineRestoreBinding> {
    if (this.active || this.reviewing || this.exporting || this.removing || backupMaintenanceActive()) throw restoreConflict('operation-busy');
    const { review } = await this.readRestoreReview(id, ownerId);
    if (!review || review.reviewId !== reviewId) throw restoreConflict('review-required');
    if (!(review.ready && review.status === 'ready') && review.status !== 'eligible')
      throw restoreConflict(review.blockers[0]?.code ?? 'review-required');
    if (review.status === 'eligible') {
      const protectedReview = this.reviews.get(id);
      if (!protectedReview || protectedReview.ownerId !== ownerId || !protectedReview.restoreContractSha256) throw restoreConflict('review-required');
      try {
        const capability = await this.captureRuntime.requireV6RestoreCapability();
        if (capability.contractSha256 !== protectedReview.restoreContractSha256) throw new Error('Protected restore contract changed');
      } catch {
        throw restoreConflict('image-state-unavailable');
      }
    }
    if (!review.expiresAt || review.expiresAt <= Date.now()) throw restoreConflict('review-expired');
    try {
      await this.docker.requireNoPendingAppImageUpdates();
    } catch {
      throw restoreConflict('restore-recovery-required');
    }
    const current = this.reviews.get(id)?.value;
    if (this.active || this.reviewing || this.exporting || this.removing || backupMaintenanceActive()) throw restoreConflict('operation-busy');
    if (
      !current ||
      current.reviewId !== review.reviewId ||
      (current.status !== 'ready' && current.status !== 'eligible') ||
      !current.expiresAt ||
      current.expiresAt <= Date.now()
    )
      throw restoreConflict('review-expired');
    return {
      pointId: review.pointId,
      reviewId: review.reviewId,
      archiveSha256: review.archiveSha256,
      manifestSha256: review.manifestSha256,
      machineId: review.machineId,
    };
  }
  async restoreAuthOptions(id: string, ownerId: number, request: Request, reviewId: string) {
    const binding = await this.authorizationBinding(id, ownerId, reviewId);
    const options = await this.authorization.passkeyOptions(request, binding);
    await this.authorizationBinding(id, ownerId, reviewId);
    return timeMachineRestorePasskeyOptionsSchema.assert(options);
  }
  async restoreAuthVerify(id: string, ownerId: number, request: Request, reviewId: string, method: 'password' | 'passkey', body: unknown) {
    const binding = await this.authorizationBinding(id, ownerId, reviewId);
    const grant = await (method === 'password'
      ? this.authorization.password(request, binding, body)
      : this.authorization.passkey(request, binding, body));
    await this.authorizationBinding(id, ownerId, reviewId);
    return grant;
  }
  // Server adapter only: no activation route consumes a grant until image/controller coherence is supported.
  async restoreAdmissionStatus(id: string, ownerId: number) {
    await this.initialize();
    this.available();
    const point = await this.owned(id, ownerId);
    const metadata = await this.store.metadata(point);
    const empty = { version: 1 as const, admission: null, job: null };
    const journal = await BackupRestoreJournal.latest(this.restoreDirectory);
    if (!journal) return empty;
    const receipt = await readRetainedRestoreReceipt(journal);
    if (!receipt || receipt.ownerId !== ownerId || receipt.binding.pointId !== id) return empty;
    if (
      receipt.binding.archiveSha256 !== metadata.archiveSha256 ||
      receipt.binding.manifestSha256 !== metadata.manifestSha256 ||
      receipt.binding.machineId !== (await this.store.machineIdentity())
    )
      throw restoreConflict('point-integrity-failed');
    let hasRootRequest = false;
    try {
      await fs.lstat(path.join(journal.directory, 'retained-root-request.json'));
      hasRootRequest = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw restoreConflict('restore-recovery-required');
    }
    const status = hasRootRequest ? await this.restores.retainedStatus(journal, ownerId) : await this.restores.status();
    const current = await BackupRestoreJournal.latest(this.restoreDirectory);
    if (
      !current ||
      current.state.id !== journal.state.id ||
      current.state.nonce !== journal.state.nonce ||
      !status.job ||
      status.job.id !== receipt.restoreId
    )
      throw restoreConflict('restore-recovery-required');
    const checked = await readRetainedRestoreReceipt(current);
    if (!checked || JSON.stringify(checked) !== JSON.stringify(receipt)) throw restoreConflict('restore-recovery-required');
    return { version: 1 as const, admission: { ...receipt.binding, restoreId: receipt.restoreId }, job: status.job };
  }
  async activateAuthorized(id: string, ownerId: number, request: Request, reviewId: string, grantId: string, manifestSha256: string) {
    const binding = await this.authorizationBinding(id, ownerId, reviewId);
    if (binding.manifestSha256 !== manifestSha256) throw restoreConflict('point-integrity-failed');
    const review = this.reviews.get(id);
    if (!review || review.ownerId !== ownerId || !review.importId || !review.importExpiresAt || review.importExpiresAt <= Date.now())
      throw restoreConflict('review-expired');
    const importId = review.importId;
    const actor = await this.auth.operatorActionContext(request);
    if (actor.userId !== ownerId) throw restoreConflict('authorization-invalid');
    const verifyAccount = async () => {
      const current = await this.auth.operatorActionContext(request);
      if (current.userId !== actor.userId || current.sessionBinding !== actor.sessionBinding || current.securityBinding !== actor.securityBinding)
        throw restoreConflict('authorization-invalid');
      if (review.value.status === 'eligible') {
        if (this.reviews.get(id) !== review || !review.value.expiresAt || review.value.expiresAt <= Date.now())
          throw restoreConflict('review-expired');
        try {
          const capability = await this.captureRuntime.requireV6RestoreCapability();
          if (!review.restoreContractSha256 || capability.contractSha256 !== review.restoreContractSha256)
            throw new Error('Protected restore contract changed');
        } catch {
          throw restoreConflict('image-state-unavailable');
        }
      }
    };
    const point = await this.owned(id, ownerId);
    if (point.version !== 2 || !point.runtimeManifestSha256) throw restoreConflict('point-integrity-failed');
    const expectedRuntimeManifestSha256 = point.runtimeManifestSha256;
    const signal = AbortSignal.timeout(15 * 60_000);
    const admitted = await this.store.requireCoherentRuntime(point, signal);
    try {
      await verifyAccount();
      await this.authorizationBinding(id, ownerId, reviewId);
      if (this.reviews.get(id) !== review || review.importId !== importId) throw restoreConflict('review-expired');
      const journal = await this.restores.prepareRetained({
        importId,
        ownerId,
        binding,
        admitted,
        expectedRuntimeManifestSha256,
        admit: (journal) => this.authorization.admit(request, binding, grantId, importId, journal),
      });
      return await this.restores.beginRetainedRoot({
        journal,
        importId,
        ownerId,
        binding,
        admitted,
        expectedRuntimeManifestSha256,
        verifyAccount,
        signal,
      });
    } finally {
      await admitted.dispose();
    }
  }
  async recoverAuthorized(id: string, ownerId: number, request: Request, restoreId: string, credentials: Credentials) {
    await this.initialize();
    this.available();
    const actor = await this.auth.operatorActionContext(request);
    if (actor.userId !== ownerId) throw restoreConflict('authorization-invalid');
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    const verifyAccount = async () => {
      const current = await this.auth.operatorActionContext(request);
      if (current.userId !== actor.userId || current.sessionBinding !== actor.sessionBinding || current.securityBinding !== actor.securityBinding)
        throw restoreConflict('authorization-invalid');
    };
    await verifyAccount();
    const point = await this.owned(id, ownerId);
    const metadata = await this.store.metadata(point);
    const journal = await BackupRestoreJournal.active(this.restoreDirectory);
    if (!journal || journal.state.id !== restoreId) throw restoreConflict('restore-recovery-required');
    const receipt = await readRetainedRestoreReceipt(journal);
    if (
      !receipt ||
      receipt.ownerId !== ownerId ||
      receipt.binding.pointId !== id ||
      receipt.binding.archiveSha256 !== metadata.archiveSha256 ||
      receipt.binding.manifestSha256 !== metadata.manifestSha256 ||
      receipt.binding.machineId !== (await this.store.machineIdentity())
    )
      throw restoreConflict('point-integrity-failed');
    return this.restores.recoverRetainedRoot({
      restoreId,
      pointId: id,
      ownerId,
      binding: receipt.binding,
      verifyAccount,
      signal: AbortSignal.timeout(15 * 60_000),
    });
  }
  async activate(id: string, ownerId: number, credentials: Credentials, manifestSha256: string) {
    if (this.exporting || this.removing) throw timeMachineConflict('operation-busy');
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    await this.store.verifyArchive(await this.owned(id, ownerId));
    const point = await this.inspect(id, ownerId);
    if (!point.metadata || point.metadata.manifestSha256 !== manifestSha256) throw timeMachineConflict('point-integrity-failed');
    throw timeMachineConflict('activation-not-integrated');
  }
  async withPortablePoint<T>(
    id: string,
    ownerId: number,
    request: Request,
    credentials: Credentials,
    signal: AbortSignal,
    consume: (value: {
      point: StoredTimeMachinePoint;
      metadata: TimeMachineMetadata;
      source: Readable;
      pointKey: string;
      signal: AbortSignal;
    }) => Promise<T>,
  ) {
    await this.initialize();
    this.available();
    const actor = await this.auth.operatorActionContext(request);
    if (actor.userId !== ownerId) throw restoreConflict('authorization-invalid');
    await this.auth.verifySensitiveAction(ownerId, credentials.password, credentials.totpCode);
    const current = await this.auth.operatorActionContext(request);
    if (actor.userId !== current.userId || actor.sessionBinding !== current.sessionBinding || actor.securityBinding !== current.securityBinding)
      throw restoreConflict('authorization-invalid');
    this.available();
    if (this.active || this.reviewing || this.exporting || this.removing || backupMaintenanceActive() || installationMode().phase !== 'normal')
      throw timeMachineConflict('operation-busy');
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const abort = new AbortController();
    const operation = { abort, done };
    this.exporting = operation;
    const combined = AbortSignal.any([signal, abort.signal]);
    try {
      combined.throwIfAborted();
      const point = await this.owned(id, ownerId);
      if (point.status !== 'sealed' || point.version !== 2) throw timeMachineConflict('point-integrity-failed');
      const metadata = await this.store.metadata(point);
      if (metadata.version !== 2 || !metadata.coverage.dockerImages) throw timeMachineConflict('point-integrity-failed');
      return await this.store.withArchive(point, combined, (source, pointKey) => consume({ point, metadata, source, pointKey, signal: combined }));
    } finally {
      if (this.exporting === operation) this.exporting = undefined;
      finish();
    }
  }
  async appIcons(id: string, ownerId: number, identity: string) {
    await this.initialize();
    this.available();
    if (!timeMachineHashSchema.allows(identity)) throw timeMachineConflict('point-not-found');
    if (this.openingAssets >= 2) throw timeMachineConflict('operation-busy');
    this.openingAssets++;
    try {
      const point = await this.owned(id, ownerId);
      const metadata = await this.store.metadata(point);
      const asset = metadata.preview.available ? metadata.preview.appIcons : undefined;
      if (!asset || asset.identity !== identity) throw timeMachineConflict('point-not-found');
      return await this.store.appIcons(point, asset);
    } catch (error) {
      if (error && typeof error === 'object' && 'getResponse' in error) throw error;
      throw timeMachineConflict('point-integrity-failed');
    } finally {
      this.openingAssets--;
    }
  }
  async wallpaper(id: string, ownerId: number, identity: string) {
    await this.initialize();
    this.available();
    if (!timeMachineHashSchema.allows(identity)) throw timeMachineConflict('point-not-found');
    if (this.openingAssets >= 2) throw timeMachineConflict('operation-busy');
    this.openingAssets++;
    try {
      const point = await this.owned(id, ownerId);
      const metadata = await this.store.metadata(point);
      const preview = metadata.preview;
      if (!preview.available || !preview.wallpaperAsset.available || preview.wallpaperAsset.identity !== identity)
        throw timeMachineConflict('point-not-found');
      return await this.store.wallpaper(point, preview.wallpaperAsset);
    } catch (error) {
      if (error && typeof error === 'object' && 'getResponse' in error) throw error;
      throw timeMachineConflict('point-integrity-failed');
    } finally {
      this.openingAssets--;
    }
  }
}
