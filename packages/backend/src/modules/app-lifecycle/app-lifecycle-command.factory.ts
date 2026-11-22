import { reconcileFreshInstall } from './commands/resume-fresh-install';
import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import { DockerService, type RestoreComposeStart } from '../docker/docker.service';
import { DOCKERODE } from '../docker/docker.module';
import type { AppEventFormInput, appEventSchema } from '../queue/entities/app-events';
import { BackupAppCommand } from './commands/backup-app-command';
import { GenerateAppEnvCommand } from './commands/generate-env-command';
import { InstallAppCommand } from './commands/install-app-command';
import { ResetAppCommand } from './commands/reset-app-command';
import { RestartAppCommand } from './commands/restart-app-command';
import { RestoreAppCommand } from './commands/restore-app-command';
import { StartAppCommand } from './commands/start-app-command';
import { StopAppCommand } from './commands/stop-app-command';
import { UninstallAppCommand } from './commands/uninstall-app-command';
import { UpdateAppCommand } from './commands/update-app-command';
import { TasksService } from '../tasks/tasks.service';
import type { InstallRequestOwnership } from './install-request-receipt';
import { reconcileAppUpdateCommit, resumeAppUpdate } from './commands/resume-app-update';
import { AppJobService, type AppJobContext, type JobEvent } from './services/app-job.service';
import type { appEventResultSchema } from '../queue/entities/app-events';

@Injectable()
export class AppLifecycleCommandFactory {
  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(DOCKERODE) private readonly docker: Dockerode,
  ) {}

  async resumeRestoredApp(appUrn: typeof appEventSchema.infer.appUrn, form: AppEventFormInput, start: RestoreComposeStart) {
    const result = await new StartAppCommand(this.moduleRef, this.docker).execute(appUrn, form, start);
    if (!result.success) throw new Error(result.message);
  }

  beginJob(event: JobEvent, resuming: boolean) {
    return this.moduleRef.get(AppJobService, { strict: false }).begin(event, resuming);
  }

  finishJob(event: JobEvent, context: AppJobContext, result: typeof appEventResultSchema.infer) {
    return this.moduleRef.get(AppJobService, { strict: false }).finish(event, context, result);
  }

  createCommand(eventData: typeof appEventSchema.infer, ownership?: InstallRequestOwnership, job?: AppJobContext) {
    const command = this.createUncheckedCommand(eventData, ownership);
    if (job) command.setJobContext(job);
    command.setProgressReporter(async (phase) => {
      try {
        await this.moduleRef.get(TasksService, { strict: false }).progress(eventData, phase);
      } catch {
        // A reporting failure cannot change the outcome of lifecycle work.
      }
    });
    return {
      execute: async (appUrn: typeof eventData.appUrn, form: typeof eventData.form) => {
        await this.moduleRef.get(DockerService, { strict: false }).requireAppImagePinUpdate(appUrn);
        return command.execute(appUrn, form);
      },
    };
  }

  reconcileInstall(eventData: Pick<typeof appEventSchema.infer, 'appUrn' | 'requestId' | 'form'>) {
    return reconcileFreshInstall({ moduleRef: this.moduleRef, docker: this.docker, ...eventData });
  }

  reconcileUpdate(eventData: Extract<typeof appEventSchema.infer, { command: 'update' }>) {
    return reconcileAppUpdateCommit({ moduleRef: this.moduleRef, appUrn: eventData.appUrn, requestId: eventData.requestId, form: eventData.form });
  }

  resumeUpdate(eventData: Extract<typeof appEventSchema.infer, { command: 'update' }>) {
    return resumeAppUpdate({
      moduleRef: this.moduleRef,
      docker: this.docker,
      appUrn: eventData.appUrn,
      requestId: eventData.requestId,
      form: eventData.form,
      performBackup: eventData.performBackup,
      report: async (phase) => {
        try {
          await this.moduleRef.get(TasksService, { strict: false }).progress(eventData, phase);
        } catch {
          /* Reporting has no activation authority. */
        }
      },
    });
  }

  private createUncheckedCommand(eventData: typeof appEventSchema.infer, ownership?: InstallRequestOwnership) {
    const command = eventData.command;

    switch (command) {
      case 'install':
        return new InstallAppCommand(this.moduleRef, this.docker, eventData.requestId, ownership);
      case 'start':
        return new StartAppCommand(this.moduleRef, this.docker);
      case 'stop':
        return new StopAppCommand(this.moduleRef, this.docker);
      case 'restart':
        return new RestartAppCommand(this.moduleRef, this.docker);
      case 'uninstall':
        return new UninstallAppCommand(this.moduleRef, this.docker, eventData.removeBackups ?? false);
      case 'reset':
        return new ResetAppCommand(this.moduleRef, this.docker);
      case 'backup':
        return new BackupAppCommand(this.moduleRef, this.docker);
      case 'restore':
        return new RestoreAppCommand(this.moduleRef, this.docker, eventData.filename);
      case 'generate_env':
        return new GenerateAppEnvCommand(this.moduleRef, this.docker);
      case 'update':
        return new UpdateAppCommand(this.moduleRef, this.docker, eventData.performBackup, eventData.requestId);
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }
}
