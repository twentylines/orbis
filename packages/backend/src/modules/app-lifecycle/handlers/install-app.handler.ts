import { readFreshInstallResult } from '../install-result';
import { requestInputHash } from '../commands/update-app-command';
import { randomUUID } from 'node:crypto';
import { enterBackupMutation } from '@/common/backup-maintenance';
import { TranslatableError } from '@/common/error/translatable-error';
import { extractAppUrn } from '@/common/helpers/app-helpers';
import { ConfigurationService } from '@/core/config/configuration.service';
import { LoggerService } from '@/core/logger/logger.service';
import type { App } from '@/core/database/drizzle/types';
import { AsyncMutex } from '@/utils/mutex/async-mutex';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import { AppStoreRepository } from '@/modules/app-stores/app-store.repository';
import { appStoreLockKey } from '@/modules/app-stores/app-store-lock';
import { ConflictException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { AppUrn } from '@runtipi/common/types';
import { type } from 'arktype';
import { AppsRepository, type InstallAppReservation } from '../../apps/apps.repository';
import { MarketplaceService } from '../../marketplace/marketplace.service';
import { AppEventsQueue, type appEventResultSchema } from '../../queue/entities/app-events';
import { appFormSchema } from '../dto/app-lifecycle.dto';
import { hasInstallRequestHold, reserveInstallRequest, takeInstallRequestReceipt } from '../install-request-receipt';
import { AppValidationService } from '../services/app-validation.service';
import { AppJobService } from '../services/app-job.service';
import { StatusManagerService } from '../services/status-manager.service';
import { StartAppHandler } from './start-app.handler';
import { type HandlerResult, type ILifecycleHandler, generateRequestId } from './base-handler';

export type InstallAppParams = {
  form: unknown;
  skipRun?: boolean;
  requireNew?: boolean;
};

@Injectable()
export class InstallAppHandler implements ILifecycleHandler<InstallAppParams> {
  private readonly owner = randomUUID();

  constructor(
    private readonly appRepository: AppsRepository,
    private readonly appEventsQueue: AppEventsQueue,
    private readonly statusManager: StatusManagerService,
    private readonly validationService: AppValidationService,
    private readonly marketplaceService: MarketplaceService,
    private readonly startAppHandler: StartAppHandler,
    private readonly appStoreRepository: AppStoreRepository,
    @Inject(APP_ASYNC_MUTEX) private readonly mutex: AsyncMutex,
    private readonly config: ConfigurationService,
    private readonly logger: LoggerService,
    private readonly jobs: AppJobService,
  ) {}

  async execute(appUrn: AppUrn, params?: InstallAppParams): Promise<HandlerResult> {
    const { form, skipRun = false } = params ?? { form: {} };

    this.statusManager.emitEvent({ appUrn, event: 'status_change' });

    const parsedForm = appFormSchema(form);
    if (parsedForm instanceof type.errors) {
      throw new TranslatableError('SYSTEM_ERROR_INVALID_BODY', undefined, HttpStatus.BAD_REQUEST, { cause: parsedForm });
    }

    const release = enterBackupMutation();
    if (!release) throw new ConflictException('A full backup or app recovery is in progress. Retry when it finishes.');
    let releaseApp: (() => void) | undefined;
    const requestId = generateRequestId();
    try {
      if (await this.jobs.hasUnsettledJob(appUrn))
        throw new ConflictException('Review the unfinished app operation before installing or starting this app.');
      if (this.mutex.resourceLocks.has(appUrn)) await this.requireNoInstallHold(appUrn);
      releaseApp = await this.mutex.acquire(appUrn);
      if (await this.jobs.hasUnsettledJob(appUrn))
        throw new ConflictException('Review the unfinished app operation before installing or starting this app.');
      await this.requireNoInstallHold(appUrn);
      const request = { requestId, owner: this.owner, skipRun };
      const createdApp = await this.reserveApp(appUrn, parsedForm, request, params?.requireNew);
      if (!createdApp) return await this.startAppHandler.execute(appUrn);

      const dataDir = this.config.get('directories').dataDir;
      const receipt = { ...request, app: createdApp };

      void this.appEventsQueue
        .publish({ appUrn, command: 'install', requestId, form: { ...parsedForm, skipRun } })
        .catch(() => ({ success: false, message: 'The app install outcome could not be confirmed.' }))
        .then(async (result) => {
          const { success, message } = result;
          if ('operationBlocked' in result && result.operationBlocked) return;
          if (success) return;
          const leave = enterBackupMutation();
          if (!leave) return;
          try {
            const cleanup = await takeInstallRequestReceipt(dataDir, receipt);
            if (cleanup && (await this.appRepository.deleteInstallReservation(createdApp))) {
              await this.removeSpentReceipt(cleanup);
              this.statusManager.emitEvent({
                appUrn,
                event: 'install_error',
                error: message,
                ...(createdApp.preserveExisting ? { appStatus: 'missing' as const } : {}),
              });
            }
          } finally {
            leave();
          }
        })
        .catch(() => this.statusManager.emitEvent({ appUrn, event: 'install_error', error: 'The app install outcome could not be confirmed.' }));

      return { requestId };
    } finally {
      releaseApp?.();
      release();
    }
  }

  async requireNoInstallHold(appUrn: AppUrn) {
    if (await hasInstallRequestHold(this.config.get('directories').dataDir, appUrn)) {
      throw new ConflictException('An app install is still running or needs review. Check its task before retrying.');
    }
  }

  async claim(appUrn: AppUrn, requestId: string, skipRun: boolean) {
    const app = await this.appRepository.getAppByUrn(appUrn);
    if (app?.status !== 'installing') return undefined;
    const receipt = { app, requestId, owner: this.owner, skipRun };
    const dataDir = this.config.get('directories').dataDir;
    const cleanup =
      (await takeInstallRequestReceipt(dataDir, receipt)) ??
      (await takeInstallRequestReceipt(dataDir, { ...receipt, app: { ...app, preserveExisting: true } }));
    if (cleanup) {
      return {
        form: { ...app.config, skipRun },
        ownership: cleanup.ownership,
        settle: async (result: typeof appEventResultSchema.infer) => {
          const alreadyRetired = await this.settle(cleanup.ownership.reservation, appUrn, skipRun, result, requestId);
          if (!alreadyRetired && (result.success || result.statePreserved === true)) await this.removeSpentReceipt(cleanup);
        },
      };
    }
  }

  private async removeSpentReceipt(cleanup: () => Promise<void>) {
    try {
      await cleanup();
    } catch {
      this.logger.warn('Cleanup of a spent install request receipt could not be confirmed.');
    }
  }

  private async settle(app: InstallAppReservation, appUrn: AppUrn, skipRun: boolean, result: typeof appEventResultSchema.infer, requestId: string) {
    const stored = result.success ? await readFreshInstallResult(this.config.get('directories').dataDir, appUrn, requestId) : undefined;
    if (stored) {
      const current = await this.appRepository.getAppByUrn(appUrn);
      if (
        !current ||
        stored.appId !== app.id ||
        stored.appCreatedAt !== app.createdAt ||
        stored.version !== app.version ||
        current.id !== app.id ||
        current.createdAt !== app.createdAt ||
        current.version !== app.version ||
        current.status !== stored.status ||
        !current.migrationsBaselined ||
        stored.requestInputSha256 !== requestInputHash({ ...current.config, skipRun }) ||
        (stored.status === 'stopped') !== skipRun ||
        !(await this.appRepository.readFreshInstallCommit(stored))
      )
        throw new Error('The committed app installation could not be verified.');
      this.statusManager.emitEvent({ appUrn, event: 'install_success', appStatus: stored.status });
      return result.alreadyCompleted === true;
    }
    const appStatus = result.success && !skipRun ? 'running' : 'stopped';
    const unchanged = !result.success && result.statePreserved === true;
    const settled = unchanged
      ? await this.appRepository.deleteInstallReservation(app)
      : await this.appRepository.finishInstallReservation(app, appStatus);
    if (!settled) throw new Error('The app install reservation changed before completion. Review the app task.');
    if (result.success) this.statusManager.emitEvent({ appUrn, event: 'install_success', appStatus });
    else
      this.statusManager.emitEvent({
        appUrn,
        event: 'install_error',
        error: result.message,
        ...(unchanged ? (app.preserveExisting ? { appStatus: 'missing' as const } : {}) : { appStatus }),
      });
    return false;
  }

  private async reserveApp(
    appUrn: AppUrn,
    parsedForm: typeof appFormSchema.infer,
    request: Parameters<typeof reserveInstallRequest>[2],
    requireNew = false,
  ): Promise<(App & { preserveExisting?: true }) | undefined> {
    const { appName, appStoreId } = extractAppUrn(appUrn);
    const release = await this.mutex.acquire(appStoreLockKey(appStoreId));
    try {
      const app = await this.appRepository.getAppByUrn(appUrn);
      if (app) {
        if (requireNew) throw new ConflictException('This app is already installed on the selected server.');
        if (app.status === 'installing') throw new ConflictException('Wait for the current app install to finish.');
        if (appStoreId === '_user' && app.status === 'missing') {
          if (app.migrationsBaselined) throw new ConflictException('Review the existing app storage before installing this app again.');
          const appInfo = await this.marketplaceService.getAppInfoFromAppStoreOrInstalled(appUrn);
          if (!appInfo) throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn }, HttpStatus.NOT_FOUND);
          await this.validationService.validateInstallSettings(appUrn, appInfo, parsedForm, app.id);
          return await reserveInstallRequest(this.config.get('directories').dataDir, appUrn, request, async () => {
            const reserved = await this.appRepository.reserveCustomDraft(app, {
              config: parsedForm,
              version: appInfo.tipi_version,
              port: parsedForm.port ?? appInfo.port,
              exposed: parsedForm.exposed ?? false,
              domain: parsedForm.domain ?? null,
              localSubdomain: parsedForm.localSubdomain ?? null,
              openPort: parsedForm.openPort ?? false,
              exposedLocal: parsedForm.exposedLocal ?? false,
              isVisibleOnGuestDashboard: parsedForm.isVisibleOnGuestDashboard,
              enableAuth: parsedForm.enableAuth ?? false,
              maxBackups: parsedForm.maxBackups ?? null,
            });
            if (!reserved) throw new ConflictException('The custom app changed before its installation could be reserved.');
            return { ...reserved, preserveExisting: true as const };
          });
        }
        const { port, exposed, exposedLocal, openPort, domain, isVisibleOnGuestDashboard, enableAuth, localSubdomain, maxBackups } = parsedForm;
        await this.appRepository.updateAppById(app.id, {
          config: parsedForm,
          port,
          exposed,
          exposedLocal,
          openPort,
          domain,
          isVisibleOnGuestDashboard,
          enableAuth,
          localSubdomain,
          maxBackups,
        });
        return undefined;
      }

      const store = await this.appStoreRepository.getAppStoreBySlug(appStoreId);
      if (!store) throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn }, HttpStatus.NOT_FOUND);
      const { isVisibleOnGuestDashboard } = parsedForm;

      const appInfo = await this.marketplaceService.getAppInfoFromAppStoreOrInstalled(appUrn);

      if (!appInfo) {
        throw new TranslatableError('APP_ERROR_APP_NOT_FOUND', { id: appUrn }, HttpStatus.NOT_FOUND);
      }

      await this.validationService.validateInstallSettings(appUrn, appInfo, parsedForm);

      return await reserveInstallRequest(this.config.get('directories').dataDir, appUrn, request, () =>
        this.appRepository.createApp({
          appName,
          status: 'installing',
          config: parsedForm,
          port: parsedForm.port ?? appInfo.port,
          version: appInfo.tipi_version,
          exposed: parsedForm.exposed ?? false,
          domain: parsedForm.domain ?? null,
          localSubdomain: parsedForm.localSubdomain ?? null,
          openPort: parsedForm.openPort ?? false,
          exposedLocal: parsedForm.exposedLocal ?? false,
          appStoreSlug: appStoreId,
          isVisibleOnGuestDashboard,
          enableAuth: parsedForm.enableAuth ?? false,
          maxBackups: parsedForm.maxBackups ?? null,
          templateUrn: appUrn,
          lastTemplateSyncAt: Math.floor(Date.now() / 1000),
          templateVersion: appInfo.tipi_version,
        }),
      );
    } finally {
      release();
    }
  }
}
