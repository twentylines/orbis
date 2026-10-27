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
import { INSTALLATION_MESSAGE, installationHeld } from '@/common/installation-mode';
import { enterBackupMutation } from '@/common/backup-maintenance';

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
  ) {
    this.logger.debug('Subscribing to app events...');
    this.appEventsQueue.onEvent((data, reply, delivery) => this.invokeCommand(data, reply, delivery?.redelivered ?? false));
  }

  async invokeCommand(data: typeof appEventSchema.infer, reply: (response: typeof appEventResultSchema.infer) => Promise<void>, redelivered = false) {
    if (installationHeld()) {
      await reply({ success: false, message: INSTALLATION_MESSAGE });
      return;
    }
    await this.tasks.enqueue(data);
    const release = await this.mutex.acquire(data.appUrn);

    try {
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
        await this.recoverInterruptedRestore(data.appUrn);
        const command = this.commandFactory.createCommand(data);
        result = await command.execute(data.appUrn, data.form);
      } catch (err) {
        this.logger.error('Error invoking command:', err);
        result = { success: false, message: String(err) };
      }
      await this.tasks.finish(data, result.success);
      await reply(result);
    } finally {
      release();
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

  async startApp(params: { appUrn: AppUrn; skipPull?: boolean }) {
    return this.startAppHandler.execute(params.appUrn, { skipPull: params.skipPull });
  }

  async installApp(params: { appUrn: AppUrn; form: unknown; skipRun?: boolean; requireNew?: boolean }) {
    return this.installAppHandler.execute(params.appUrn, { form: params.form, skipRun: params.skipRun, requireNew: params.requireNew });
  }

  public async stopApp(params: { appUrn: AppUrn }) {
    return this.stopAppHandler.execute(params.appUrn);
  }

  public async restartApp(params: { appUrn: AppUrn; skipPull?: boolean }) {
    return this.restartAppHandler.execute(params.appUrn, { skipPull: params.skipPull });
  }

  public async uninstallApp(params: { appUrn: AppUrn; removeBackups: boolean }) {
    return this.uninstallAppHandler.execute(params.appUrn, { removeBackups: params.removeBackups });
  }

  public async resetApp(params: { appUrn: AppUrn }) {
    return this.resetAppHandler.execute(params.appUrn);
  }

  public async updateAppSettings(params: { appUrn: AppUrn; form: unknown }) {
    return this.updateConfigHandler.execute(params.appUrn, { form: params.form });
  }

  public async updateApp(params: { appUrn: AppUrn; performBackup: boolean }) {
    return this.updateAppHandler.execute(params.appUrn, { performBackup: params.performBackup });
  }

  public async backupApp(params: { appUrn: AppUrn }) {
    return this.backupAppHandler.execute(params.appUrn);
  }

  public async restoreApp(params: { appUrn: AppUrn; filename: string }) {
    return this.restoreAppHandler.execute(params.appUrn, { filename: params.filename });
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
