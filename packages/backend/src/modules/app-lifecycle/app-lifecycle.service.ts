import { createAppUrn } from '@/common/helpers/app-helpers';
import { LoggerService } from '@/core/logger/logger.service';
import { BackupManager } from '@/modules/backups/backup.manager';
import { DOCKERODE } from '@/modules/docker/docker.module';
import { APP_ASYNC_MUTEX } from '@/utils/mutex/mutex.module';
import type { AsyncMutex } from '@/utils/mutex/async-mutex';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { AppUrn } from '@runtipi/common/types';
import type Dockerode from 'dockerode';
import { AppsRepository } from '../apps/apps.repository';
import { AppsService } from '../apps/apps.service';
import { AppEventsQueue, appEventResultSchema, appEventSchema } from '../queue/entities/app-events';
import { AppLifecycleCommandFactory } from './app-lifecycle-command.factory';
import { InstallAppHandler } from './handlers/install-app.handler';
import { ResetAppHandler } from './handlers/reset-app.handler';
import { RestartAppHandler } from './handlers/restart-app.handler';
import { StartAppHandler } from './handlers/start-app.handler';
import { StopAppHandler } from './handlers/stop-app.handler';
import { UninstallAppHandler } from './handlers/uninstall-app.handler';
import { UpdateAppHandler } from './handlers/update-app.handler';
import { UpdateConfigHandler } from './handlers/update-config.handler';
import { BackupAppHandler } from './handlers/backup-app.handler';
import { RestoreAppHandler } from './handlers/restore-app.handler';
import { TasksService } from '../tasks/tasks.service';
import { INSTALLATION_MESSAGE, installationHeld, installationMode } from '@/common/installation-mode';
import type { RestoreComposeStart } from '../docker/docker.service';
import { enterBackupMutation } from '@/common/backup-maintenance';
import { AppJobService, type AppJobContext, type JobEvent } from './services/app-job.service';

@Injectable()
export class AppLifecycleService {
  constructor(
    private readonly logger: LoggerService,
    private readonly appEventsQueue: AppEventsQueue,
    private readonly commandFactory: AppLifecycleCommandFactory,
    private readonly appRepository: AppsRepository,
    private readonly appsService: AppsService,
    @Inject(APP_ASYNC_MUTEX) private mutex: AsyncMutex,
    private readonly startAppHandler: StartAppHandler,
    private readonly stopAppHandler: StopAppHandler,
    private readonly restartAppHandler: RestartAppHandler,
    private readonly installAppHandler: InstallAppHandler,
    private readonly uninstallAppHandler: UninstallAppHandler,
    private readonly resetAppHandler: ResetAppHandler,
    private readonly updateConfigHandler: UpdateConfigHandler,
    private readonly updateAppHandler: UpdateAppHandler,
    private readonly backupAppHandler: BackupAppHandler,
    private readonly restoreAppHandler: RestoreAppHandler,
    private readonly tasks: TasksService,
    private readonly backups: BackupManager,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
    private readonly jobs: AppJobService,
  ) {
    this.logger.debug('Subscribing to app events...');
    this.appEventsQueue.onEvent((data, reply, delivery) => this.invokeCommand(data, reply, delivery?.redelivered ?? false));
  }

  async invokeCommand(
    data: typeof appEventSchema.infer,
    deliverResponse: (response: typeof appEventResultSchema.infer) => Promise<void>,
    redelivered = false,
  ) {
    let reply = deliverResponse;
    if (installationHeld()) {
      await reply({ success: false, message: INSTALLATION_MESSAGE });
      return;
    }
    await this.tasks.enqueue(data);
    const release = await this.mutex.acquire(data.appUrn);
    let job: AppJobContext | undefined;
    let jobSettled = false;
    let freshJob = false;

    try {
      if (!('jobVersion' in data && data.jobVersion === 1)) {
        let blocked = true;
        try {
          blocked = await this.jobs.hasUnsettledJob(data.appUrn);
        } catch {
          this.logger.warn('The current app operation could not be verified. The queued action was preserved without execution.');
        }
        if (blocked) {
          try {
            const previous = (await this.tasks.read()).tasks.find((task) => task.id === data.requestId);
            if (previous?.appUrn === data.appUrn && previous.action === data.command && previous.status === 'queued' && previous.startedAt === null)
              await this.tasks.finish(data, false);
          } catch {
            this.logger.warn('The blocked app action could not be recorded in task history.');
          }
          await reply({
            success: false,
            message: 'Review the unfinished app operation before starting another app action.',
            statePreserved: true,
            operationBlocked: true,
          });
          return;
        }
      }
      if ('jobVersion' in data && data.jobVersion === 1) {
        if (data.command !== 'backup' && data.command !== 'update') throw new Error('Invalid app operation command.');
        const jobEvent = data as JobEvent;
        const previous = (await this.tasks.read()).tasks.find((task) => task.id === data.requestId);
        const begun = await this.commandFactory.beginJob(jobEvent, redelivered || previous?.status !== 'queued');
        if (begun.result) {
          await reply(begun.result);
          return;
        }
        job = begun.context;
        if (!job) throw new Error('The app operation worker could not be verified.');
        freshJob = begun.fresh === true;
        const deliver = reply;
        const currentJob = job;
        const currentEvent = jobEvent;
        reply = async (result) => {
          jobSettled = true;
          await deliver(await this.commandFactory.finishJob(currentEvent, currentJob, result));
        };
      }
      let install: Awaited<ReturnType<InstallAppHandler['claim']>>;
      if (data.command === 'install') {
        const previous = (await this.tasks.read()).tasks.find((task) => task.id === data.requestId);
        if (previous && (previous.appUrn !== data.appUrn || previous.action !== data.command)) {
          await reply({ success: false, message: 'This install request does not match its recorded operation.' });
          return;
        }
        if (previous?.status === 'succeeded') {
          const completed = await this.reconcileInstall(data);
          await reply(completed ?? { success: true, message: 'This install request has already completed.', alreadyCompleted: true });
          return;
        }

        try {
          if (!redelivered) install = await this.installAppHandler.claim(data.appUrn, data.requestId, data.form.skipRun === true);
        } catch {
          this.logger.warn('An app install receipt could not be verified. Its files were preserved.');
        }
        if (!install) {
          const completed = await this.reconcileInstall(data);
          if (completed) {
            await this.tasks.finish(data, true);
            await reply(completed);
            return;
          }
          await this.tasks.interrupt(data);
          await reply({ success: false, message: 'This install request no longer owns an app reservation. Review the app before retrying.' });
          return;
        }
      } else if (data.command !== 'stop' && data.command !== 'uninstall') {
        try {
          await this.installAppHandler.requireNoInstallHold(data.appUrn);
        } catch (error) {
          await this.tasks.finish(data, false);
          await reply({
            success: false,
            message: error instanceof ConflictException ? error.message : 'The app install hold could not be verified.',
          });
          return;
        }
      }
      if (data.command === 'generate_env') {
        const previous = (await this.tasks.read()).tasks.find((task) => task.id === data.requestId);
        if (previous && (previous.appUrn !== data.appUrn || previous.action !== data.command))
          throw new Error('Settings request identity does not match its task.');
        if (redelivered || previous?.status !== 'queued') {
          const completed = previous?.status === 'succeeded';
          if (!completed && previous?.status !== 'failed') await this.tasks.interrupt(data);
          await reply({
            success: completed,
            ...(completed ? { alreadyCompleted: true } : {}),
            message: completed ? 'These settings have already been saved.' : 'This settings request was interrupted. Refresh before saving again.',
          });
          return;
        }
        if (!data.settingsBinding || (await this.jobs.hasUnsettledJob(data.appUrn)) || (await this.backups.hasPendingRestore(data.appUrn))) {
          await this.tasks.finish(data, false);
          await reply({
            success: false,
            message: 'Refresh the app and resolve any unfinished operation before saving its settings.',
            statePreserved: true,
          });
          return;
        }
      }
      if (data.command === 'update') {
        const previous = (await this.tasks.read()).tasks.find((task) => task.id === data.requestId);
        if (previous && (previous.appUrn !== data.appUrn || previous.action !== data.command)) {
          await reply({ success: false, message: 'This update request does not match its recorded operation.' });
          return;
        }
        if (previous?.status === 'succeeded') {
          await reply({ success: true, message: 'This update request has already completed.', alreadyCompleted: true });
          return;
        }
        if (!freshJob && (redelivered || previous?.status !== 'queued')) {
          if (previous?.status === 'failed') {
            const committed = await this.reconcileUpdate(data);
            if (committed) {
              await this.tasks.finish(data, true);
              await reply(committed);
              return;
            }
            await reply({ success: false, message: 'This update request has already failed. Review the app before retrying.' });
            return;
          }
          let resumed: typeof appEventResultSchema.infer;
          try {
            // A competing restore must never be promoted as a side effect of update redelivery.
            if (await this.backups.hasPendingRestore(data.appUrn)) throw new Error('Restore recovery is pending.');
            await this.tasks.start(data);
            resumed = await this.commandFactory.resumeUpdate(data);
            if (!resumed) throw new Error('The saved update could not be verified.');
          } catch {
            resumed = { success: false, message: 'This update was interrupted. Review the app before starting a new update.' };
          }
          if (!job) {
            if (resumed.success || resumed.statePreserved === true) await this.tasks.finish(data, resumed.success);
            else await this.tasks.interrupt(data);
          }
          await reply(resumed);
          return;
        }
      }
      if (data.command === 'restore') {
        const previous = (await this.tasks.read()).tasks.find((task) => task.id === data.requestId);
        if (previous && (previous.appUrn !== data.appUrn || previous.action !== data.command))
          throw new Error('Restore request identity does not match its task');
        if (redelivered || previous?.status !== 'queued') {
          await this.recoverInterruptedRestore(data.appUrn);
          await this.tasks.interrupt(data);
          await reply({
            success: previous?.status === 'succeeded',
            message:
              previous?.status === 'succeeded'
                ? 'This restore request has already completed.'
                : previous?.status === 'failed'
                  ? 'This restore request has already failed. Review the app before retrying.'
                  : 'This restore was interrupted. Review the app before starting a new restore.',
          });
          return;
        }
      }
      await this.tasks.start(data);
      let result: typeof appEventResultSchema.infer;
      try {
        if (install) {
          if (await this.backups.hasPendingRestore(data.appUrn))
            throw new Error('An interrupted restore requires recovery before installing this app.');
        } else {
          await this.recoverInterruptedRestore(data.appUrn);
        }
        const command = install
          ? this.commandFactory.createCommand(data, install.ownership)
          : job
            ? this.commandFactory.createCommand(data, undefined, job)
            : this.commandFactory.createCommand(data);
        result = await command.execute(data.appUrn, install?.form ?? data.form);
      } catch (err) {
        this.logger.error('Error invoking command:', err);
        result = { success: false, message: String(err) };
      }
      if (install) {
        if (!result.success && result.statePreserved !== true) result = (await this.reconcileInstall(data)) ?? result;
        try {
          await install.settle(result);
        } catch (err) {
          this.logger.error('Error settling app install:', err);
          result = { success: false, message: 'The app install outcome could not be recorded. Review the app before retrying.' };
        }
      }
      if (data.command === 'update' && !result.success && result.statePreserved !== true) result = (await this.reconcileUpdate(data)) ?? result;
      if (!job) await this.tasks.finish(data, result.success);
      await reply(result);
    } catch (error) {
      if (job && !jobSettled) {
        await reply({ success: false, message: 'The app operation was interrupted. Review recovery before retrying.' });
      } else throw error;
    } finally {
      release();
    }
  }

  private async reconcileInstall(data: Pick<typeof appEventSchema.infer, 'appUrn' | 'requestId' | 'form'>) {
    try {
      const completed = await this.commandFactory.reconcileInstall(data);
      return completed?.success && completed.alreadyCompleted ? completed : undefined;
    } catch {
      return;
    }
  }

  private async reconcileUpdate(data: Extract<typeof appEventSchema.infer, { command: 'update' }>) {
    try {
      if (await this.backups.hasPendingRestore(data.appUrn)) return;
      const committed = await this.commandFactory.reconcileUpdate(data);
      return committed?.success && committed.alreadyCompleted ? committed : undefined;
    } catch {
      return;
    }
  }

  private async recoverInterruptedRestore(appUrn: AppUrn) {
    if (!(await this.backups.hasPendingRestore(appUrn))) return;
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${appUrn.replace(':', '_')}`] },
    });
    for (const info of containers) {
      const container = this.docker.getContainer(info.Id);
      const inspect = () =>
        container.inspect().catch((error: unknown) => {
          if ((error as { statusCode?: number } | null)?.statusCode === 404) return null;
          throw error;
        });
      const state = await inspect();
      if (state && (state.State.Running || state.State.Restarting || state.State.Paused)) {
        if (state.State.Paused) await container.unpause();
        await container.stop({ t: 30 }).catch((error: unknown) => {
          if ((error as { statusCode?: number } | null)?.statusCode !== 304) throw error;
        });
        const stopped = await inspect();
        if (stopped && (stopped.State.Running || stopped.State.Restarting || stopped.State.Paused))
          throw new Error('App containers must be stopped before restore recovery');
      }
    }
    await this.backups.recoverRestore(appUrn);
    this.logger.info(`Recovered interrupted restore for ${appUrn}; app remains stopped`);
  }

  public async requireNoPendingRestores() {
    if ((await this.backups.getPendingRestores()).length) {
      throw new Error('An interrupted restore needs recovery before installation can resume.');
    }
  }

  public async recoverInterruptedRestores() {
    for (const appUrn of await this.backups.getPendingRestores()) {
      const release = await this.mutex.acquire(appUrn);
      try {
        await this.recoverInterruptedRestore(appUrn);
      } finally {
        release();
      }
    }
  }

  private async admitAppRequest<T>(appUrn: AppUrn, request: () => Promise<T>, allowInstallRecovery = false) {
    if (await this.jobs.hasUnsettledJob(appUrn))
      throw new ConflictException('Review the unfinished app operation before starting another app action.');
    if (!allowInstallRecovery && this.mutex.resourceLocks.has(appUrn)) await this.installAppHandler.requireNoInstallHold(appUrn);
    const release = await this.mutex.acquire(appUrn);
    try {
      if (await this.jobs.hasUnsettledJob(appUrn))
        throw new ConflictException('Review the unfinished app operation before starting another app action.');
      if (!allowInstallRecovery) await this.installAppHandler.requireNoInstallHold(appUrn);
      return await request();
    } finally {
      release();
    }
  }

  async resumeRestoredApp(appUrn: AppUrn, transactionId: string, appId: number, start: RestoreComposeStart) {
    const mode = installationMode();
    if (mode.phase !== 'resume' || mode.transactionId !== transactionId) throw new Error('Restore app startup is held.');
    await this.admitAppRequest(appUrn, async () => {
      const app = await this.appRepository.getAppById(appId);
      if (!app || createAppUrn(app.appName, app.appStoreSlug) !== appUrn) throw new Error('Restored app startup ownership changed.');
      await this.commandFactory.resumeRestoredApp(appUrn, app.config, start);
    });
  }

  async startApp(params: { appUrn: AppUrn; skipPull?: boolean }) {
    return this.admitAppRequest(params.appUrn, () => this.startAppHandler.execute(params.appUrn, { skipPull: params.skipPull }));
  }

  async installApp(params: { appUrn: AppUrn; form: unknown; skipRun?: boolean; requireNew?: boolean }) {
    return this.installAppHandler.execute(params.appUrn, { form: params.form, skipRun: params.skipRun, requireNew: params.requireNew });
  }

  public async stopApp(params: { appUrn: AppUrn }) {
    return this.admitAppRequest(params.appUrn, () => this.stopAppHandler.execute(params.appUrn), true);
  }

  public async restartApp(params: { appUrn: AppUrn; skipPull?: boolean }) {
    return this.admitAppRequest(params.appUrn, () => this.restartAppHandler.execute(params.appUrn, { skipPull: params.skipPull }));
  }

  public async uninstallApp(params: { appUrn: AppUrn; removeBackups: boolean }) {
    return this.admitAppRequest(params.appUrn, () => this.uninstallAppHandler.execute(params.appUrn, { removeBackups: params.removeBackups }), true);
  }

  public async resetApp(params: { appUrn: AppUrn }) {
    return this.admitAppRequest(params.appUrn, () => this.resetAppHandler.execute(params.appUrn));
  }

  public async updateAppSettings(params: { appUrn: AppUrn; form: unknown }) {
    if (installationHeld()) throw new ConflictException(INSTALLATION_MESSAGE);
    if (this.mutex.resourceLocks.has(params.appUrn)) throw new ConflictException('Wait for the current app operation to finish.');
    const pending = await this.admitAppRequest(params.appUrn, async () => {
      if ((await this.jobs.hasUnsettledJob(params.appUrn)) || (await this.backups.hasPendingRestore(params.appUrn)))
        throw new ConflictException('Review the unfinished app operation before changing its settings.');
      return this.updateConfigHandler.prepare(params.appUrn, { form: params.form });
    });
    // Publication is admitted under the app lock; waiting for its worker must happen after release.
    return pending.complete();
  }

  public async deleteAppBackup(params: { appUrn: AppUrn; filename: string }) {
    if (installationHeld()) throw new ConflictException(INSTALLATION_MESSAGE);
    const leave = enterBackupMutation();
    if (!leave) throw new ConflictException('A full backup or app recovery is in progress. Retry when it finishes.');
    let release: (() => void) | undefined;
    try {
      if (this.mutex.resourceLocks.has(params.appUrn)) throw new ConflictException('Wait for the current app operation to finish.');
      release = await this.mutex.acquire(params.appUrn);
      await this.installAppHandler.requireNoInstallHold(params.appUrn);
      if ((await this.jobs.hasUnsettledJob(params.appUrn)) || (await this.backups.hasPendingRestore(params.appUrn)))
        throw new ConflictException('Review the unfinished app operation before deleting its backups.');
      await this.backups.deleteBackup(params.appUrn, params.filename);
    } finally {
      release?.();
      leave();
    }
  }

  public async updateApp(params: { appUrn: AppUrn; performBackup: boolean }) {
    return this.admitAppRequest(params.appUrn, () => this.updateAppHandler.execute(params.appUrn, { performBackup: params.performBackup }));
  }

  public async backupApp(params: { appUrn: AppUrn }) {
    return this.admitAppRequest(params.appUrn, () => this.backupAppHandler.execute(params.appUrn));
  }

  public async restoreApp(params: { appUrn: AppUrn; filename: string }) {
    return this.admitAppRequest(params.appUrn, () => this.restoreAppHandler.execute(params.appUrn, { filename: params.filename }));
  }

  async updateAllApps() {
    const installedApps = await this.appsService.getInstalledApps();
    const availableUpdates = installedApps.filter(
      ({ app, metadata }) => Number(app.version) < Number(metadata.latestVersion) && app.ignoredVersion !== metadata.latestVersion,
    );

    for (const { app } of availableUpdates) {
      try {
        const appUrn = createAppUrn(app.appName, app.appStoreSlug);
        await this.updateApp({ appUrn, performBackup: true });
      } catch (e) {
        this.logger.error(`Failed to update app ${app.id}`, e);
      }
    }
  }

  private async forApps(status: 'running' | 'stopped', operation: (appUrn: AppUrn) => Promise<unknown>) {
    const release = enterBackupMutation();
    if (!release) throw new ConflictException('A full backup or app recovery is in progress. Retry when it finishes.');
    try {
      const apps = (await this.appRepository.getApps()).filter((app) => app.status === status);
      for (const app of apps) {
        try {
          await operation(createAppUrn(app.appName, app.appStoreSlug));
        } catch {
          this.logger.warn('A bulk app action failed. Review its app task before retrying.');
        }
      }
    } finally {
      release();
    }
  }

  restartRunningApps() {
    return this.forApps('running', (appUrn) => this.startApp({ appUrn, skipPull: true }));
  }
  startAllApps() {
    return this.forApps('stopped', (appUrn) => this.startApp({ appUrn, skipPull: true }));
  }
  stopAllApps() {
    return this.forApps('running', (appUrn) => this.stopApp({ appUrn }));
  }
  backupAllApps() {
    return this.forApps('running', (appUrn) => this.backupApp({ appUrn }));
  }
  restartAllApps() {
    return this.forApps('running', (appUrn) => this.restartApp({ appUrn }));
  }
}
