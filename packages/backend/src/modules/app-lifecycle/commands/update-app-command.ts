import path from 'node:path';
import { ArchiveService } from '@/core/archive/archive.service';
import { AppUpdateMigrations } from '@/modules/docker/app-update-migrations';
import { verifyAppUpdateRuntime } from './app-update-runtime';
import { ConfigurationService } from '@/core/config/configuration.service';
import { appUpdateInputHash, appUpdateSettings } from '../../apps/app-update-settings';
import { appFormSchema } from '../dto/app-lifecycle.dto';
import { AppValidationService } from '../services/app-validation.service';
import { AppFilesManager } from '@/modules/apps/app-files-manager';
import { AppHelpers } from '@/modules/apps/app.helpers';
import { AppsRepository } from '@/modules/apps/apps.repository';
import type { StagedAppImageUpdate } from '@/modules/docker/app-image-pins';
import { AppUpdateStage } from '@/modules/docker/app-update-stage';
import { ExistingAppBaseline, verifyExistingAppBaseline } from '@/modules/docker/app-existing-storage';
import { DockerComposeBuilder } from '@/modules/docker/builders/compose.builder';
import { DockerService } from '@/modules/docker/docker.service';
import { MarketplaceService } from '@/modules/marketplace/marketplace.service';
import { SubnetManagerService } from '@/modules/network/subnet-manager.service';
import type { AppEventFormInput, appEventResultSchema } from '@/modules/queue/entities/app-events';
import type { ModuleRef } from '@nestjs/core';
import { dynamicComposeSchemaYaml } from '@runtipi/common/schemas';
import type { AppUrn } from '@runtipi/common/types';
import { type } from 'arktype';
import type Dockerode from 'dockerode';
import { isActiveAppContainer, resumeAppContainers, type AppContainerSnapshot } from './backup-app-runtime';
import { rollbackMigratingAppUpdate } from './rollback-app-update';
import { AppLifecycleCommand } from './command';

type RuntimeStatus = 'running' | 'stopped';
const inspectionError = () => new Error('The current app containers could not be verified for update.');
const recovery = () => new Error('App update requires explicit recovery. Its metadata and any new app writes were preserved.');
export const requestInputHash = appUpdateInputHash;

async function captureRuntime(docker: Dockerode, appUrn: AppUrn) {
  const project = appUrn.replace(':', '_');
  const listed = await docker.listContainers({ all: true, filters: { label: [`com.docker.compose.project=${project}`] } });
  const entries: (AppContainerSnapshot & { service?: string; image: string })[] = [];
  for (const item of listed) {
    const container = docker.getContainer(item.Id);
    const inspected = await container.inspect();
    const labels = inspected.Config.Labels;
    if (
      inspected.Id !== item.Id ||
      labels?.['com.docker.compose.project'] !== project ||
      labels['runtipi.managed'] !== 'true' ||
      labels['runtipi.appurn'] !== appUrn ||
      ['Running', 'Paused', 'Restarting'].some((key) => typeof Reflect.get(inspected.State, key) !== 'boolean')
    )
      throw inspectionError();
    entries.push({ container, state: inspected.State, service: labels['com.docker.compose.service'], image: inspected.Image });
  }
  const ids = listed.map(({ Id }) => Id).sort();
  if (new Set(ids).size !== ids.length) throw inspectionError();
  const status: RuntimeStatus = entries.some(({ state }) => isActiveAppContainer(state)) ? 'running' : 'stopped';
  return { entries, ids, status };
}

export class UpdateAppCommand extends AppLifecycleCommand {
  constructor(
    moduleRef: ModuleRef,
    docker: Dockerode,
    private readonly performBackup: boolean = true,
    private readonly requestId?: string,
  ) {
    super(moduleRef, docker);
  }

  public async execute(appUrn: AppUrn, form: AppEventFormInput): Promise<typeof appEventResultSchema.infer> {
    const appFilesManager = this.moduleRef.get(AppFilesManager, { strict: false });
    const appHelpers = this.moduleRef.get(AppHelpers, { strict: false });
    const repository = this.moduleRef.get(AppsRepository, { strict: false });
    const config = this.moduleRef.get(ConfigurationService, { strict: false });
    const dockerService = this.moduleRef.get(DockerService, { strict: false });
    const marketplace = this.moduleRef.get(MarketplaceService, { strict: false });
    const subnetManager = this.moduleRef.get(SubnetManagerService, { strict: false });

    let previous: Awaited<ReturnType<typeof captureRuntime>> | undefined;
    let transaction: StagedAppImageUpdate | undefined;
    let plan: Awaited<ReturnType<DockerService['prepareStagedAppUpdate']>> | undefined;
    let migrations: AppUpdateMigrations | undefined;
    let runtimeTouched = false;
    let recoveryRequired = false;
    try {
      this.job?.check();
      const installed = await repository.getAppByUrn(appUrn);
      if (!installed || installed.status !== 'updating') return { success: false, message: 'This app update request is no longer current.' };
      await this.reportProgress('preparing');
      previous = await captureRuntime(this.docker, appUrn);
      const { transaction: update, retained } = this.requestId
        ? await dockerService.beginStagedAppUpdate(appUrn, this.requestId)
        : await dockerService.beginStagedAppUpdate(appUrn);
      transaction = update;

      await marketplace.stageAppUpdate(appUrn, update.targetDirectory);
      const [targetInfo, targetSource] = await Promise.all([
        appFilesManager.getInstalledAppInfo(appUrn, update.targetDirectory),
        appFilesManager.getSourceDockerComposeYaml(appUrn, update.targetDirectory),
      ]);
      const target = dynamicComposeSchemaYaml(targetSource.content);
      if (!targetInfo || target instanceof type.errors) throw new Error('The target app package is invalid.');

      const targetForm = appFormSchema.assert(structuredClone(form));
      await this.moduleRef.get(AppValidationService, { strict: false }).validateUpdateConfigSettings(appUrn, targetInfo, targetForm, installed.id);
      const settings = appUpdateSettings(targetInfo, form, targetForm);
      const environment = await appHelpers.renderAppEnv(appUrn, targetInfo, targetForm);
      const architecture = config.get('architecture');
      const builder = new DockerComposeBuilder();
      const subnet = await subnetManager.planUpdateSubnet(appUrn, installed.subnet);
      await update.stageTarget(builder.getDockerCompose(target, targetForm, appUrn, subnet, architecture), environment);
      if (update instanceof AppUpdateStage) await update.recordUpdateSettings(settings);
      const targetMigrationIds = await appFilesManager.getAppMigrationIds(appUrn, update.targetDirectory);
      let adoptExistingBaseline = false;
      let previousLedger = { baselined: false, migrationIds: [] as string[] };
      if (installed.migrationsBaselined) {
        const ledger = await repository.getMigrationLedger(installed.id);
        if (!ledger.baselined) throw new Error('Application migration history changed during update.');
        previousLedger = ledger;
        const known = new Set(ledger.migrationIds);
        if (targetMigrationIds.some((id) => !known.has(id)) && !(update instanceof AppUpdateStage))
          throw new Error('This update requires app migrations that Orbis cannot run yet.');
      } else {
        const previousMigrationIds = await appFilesManager.getAppMigrationIds(appUrn);
        adoptExistingBaseline = previousMigrationIds.length > 0 || targetMigrationIds.length > 0;
        if (adoptExistingBaseline) {
          const ledger = await repository.getMigrationLedger(installed.id);
          if (!ledger || ledger.baselined || ledger.migrationIds.length)
            throw new Error('This update requires verified application migration history.');
        }
        if (adoptExistingBaseline && !(update instanceof AppUpdateStage))
          throw new Error('This update requires verified application migration history.');
      }
      plan = this.job
        ? await dockerService.prepareStagedAppUpdate(appUrn, update.id, this.docker, { signal: this.job.signal })
        : await dockerService.prepareStagedAppUpdate(appUrn, update.id, this.docker);
      await this.reportProgress('pulling_images');
      const pulled = await plan.pull();
      await update.recordPulledImages(pulled);
      this.job?.check();
      if (!(await plan.isCurrent())) throw new Error('App overrides or storage changed while pulling the target images.');
      await subnetManager.reserveUpdateSubnet(appUrn, installed.subnet, subnet);
      previous = await captureRuntime(this.docker, appUrn);
      if (!(await plan.isCurrent())) throw new Error('App overrides or storage changed before the update could stop the current deployment.');
      const updateStatus = previous.status;
      if (update instanceof AppUpdateStage) {
        if (adoptExistingBaseline) {
          const proof = await ExistingAppBaseline.open({
            stage: update,
            service: dockerService,
            docker: this.docker,
            appUrn,
            localDirectory: appFilesManager.getAppPaths(appUrn).appDataDir,
            socketPath: process.env.ORBIS_HOST_SOCKET ?? '',
            appId: installed.id,
            appCreatedAt: installed.createdAt,
            version: installed.version,
            requestInputSha256: requestInputHash(form),
            originalContainers: previous.entries.map(({ container, state, service, image }) => {
              if (!service) throw inspectionError();
              return { id: container.id, imageId: image, service, running: state.Running, paused: state.Paused, restarting: state.Restarting };
            }),
          });
          try {
            await this.job?.seal();
            await update.recordExistingBaseline(proof);
            try {
              await repository.commitExistingAppBaseline(update, proof);
            } catch (error) {
              const adopted = (await update.read()).existingBaseline;
              if (!adopted || !(await repository.readExistingAppBaseline(adopted.binding))) throw error;
            }
            await verifyExistingAppBaseline(proof, update);
            previousLedger = await update.confirmExistingBaseline(repository);
          } finally {
            await proof.close();
          }
          if (!(await plan.isCurrent())) throw recovery();
        }
        await update.recordContext({
          appId: installed.id,
          appCreatedAt: installed.createdAt,
          fromVersion: installed.version,
          toVersion: targetInfo.tipi_version,
          requestInputSha256: requestInputHash(form),
          settings,
          authoritySha256: plan.inputsSha256,
          previousLedger,
          targetMigrationIds,
          updateStatus,
          originalContainers: previous.entries.map(({ container, state, service, image }) => {
            if (!service) throw inspectionError();
            return { id: container.id, imageId: image, service, running: state.Running, paused: state.Paused, restarting: state.Restarting };
          }),
        });
      }
      if (targetMigrationIds.some((id) => !previousLedger.migrationIds.includes(id))) {
        if (!(update instanceof AppUpdateStage) || !this.requestId) throw recovery();
        migrations = await AppUpdateMigrations.prepare({
          stage: update,
          appUrn,
          docker: this.docker,
          service: dockerService,
          localDirectory: appFilesManager.getAppPaths(appUrn).appDataDir,
          journalRoot: path.join(config.get('directories').dataDir, 'state', 'orbis-app-migrations'),
          socketPath: process.env.ORBIS_HOST_SOCKET ?? '',
          architecture,
          archive: this.moduleRef.get(ArchiveService, { strict: false }),
        });
        if (!(await plan.isCurrent())) throw new Error('App inputs changed while preparing migrations.');
      }
      await this.reportProgress('stopping');
      this.job?.check();
      for (const { container, state } of previous.entries) {
        if (!isActiveAppContainer(state)) continue;
        runtimeTouched = true;
        if (state.Paused) await container.unpause();
        await container.stop({ t: 30 }).catch((error: unknown) => {
          if ((error as { statusCode?: number } | null)?.statusCode !== 304) throw error;
        });
      }
      const stopped = await captureRuntime(this.docker, appUrn);
      if (stopped.status !== 'stopped' || stopped.ids.join('|') !== previous.ids.join('|')) throw inspectionError();
      if (this.performBackup) {
        await this.reportProgress('backing_up');
        await this.captureStoppedAppBackup(appUrn);
      }

      if (migrations) {
        await this.reportProgress('backing_up');
        await migrations.capture();
        await this.job?.seal();
        await this.reportProgress('migrating');
        await migrations.run();
        if (!(await plan.isCurrent())) throw new Error('App inputs changed during migrations.');
      }

      await this.reportProgress('publishing');
      await this.job?.seal();
      await update.publishTarget();
      if (updateStatus === 'running') {
        recoveryRequired = true;
        await migrations?.activationAttempted();
        await update.activationAttempted();
        await this.reportProgress('starting');
        await plan.activate();
        await this.reportProgress('verifying');
        const ready = await captureRuntime(this.docker, appUrn);
        if (
          ready.status !== 'running' ||
          ready.entries.some(({ service, image }) => !service || !Object.hasOwn(pulled.imageIds, service) || pulled.imageIds[service] !== image)
        )
          throw recovery();
      } else {
        recoveryRequired = true;
        await this.reportProgress('verifying');
        const current = await captureRuntime(this.docker, appUrn);
        if (current.status !== 'stopped' || current.ids.join('|') !== previous.ids.join('|')) throw recovery();
      }
      if (update instanceof AppUpdateStage) {
        const context = (await update.read()).context;
        if (!context) throw recovery();
        await verifyAppUpdateRuntime(this.docker, appUrn, context, update.id, pulled.imageIds);
      }
      const inputsChanged = updateStatus === 'running' && !(await plan.isCurrent().catch(() => false));
      recoveryRequired = true;
      await this.reportProgress('committing');
      await migrations?.beginCommit();
      if (!migrations && update instanceof AppUpdateStage) {
        await update.commitOrdinary(repository, updateStatus === 'running' ? inputsChanged : null);
      } else
        await update.commit(async () => {
          if (migrations) {
            await migrations.commit(repository, updateStatus, updateStatus === 'running' ? inputsChanged : undefined);
            return;
          }
          if (retained) await dockerService.retireAppImagePinsAfterUpdate(appUrn, update.id);
          const updated = await repository.updateAppById(installed.id, {
            ...settings.values,
            version: targetInfo.tipi_version,
            status: updateStatus,
            ...(updateStatus === 'running' ? { pendingRestart: inputsChanged } : {}),
          });
          if (!updated) throw recovery();
        });

      return { success: true, message: `App ${appUrn} updated successfully`, updateStatus };
    } catch (error) {
      if (recoveryRequired) return this.handleAppError(recovery(), appUrn, 'update_error');
      try {
        await this.reportProgress('recovering');
        if (migrations && transaction instanceof AppUpdateStage) {
          await rollbackMigratingAppUpdate({ stage: transaction, migrations, repository, docker: this.docker, appUrn });
        } else {
          await transaction?.restoreMetadata();
          if (runtimeTouched && previous) await resumeAppContainers(previous.entries);
        }
      } catch (rollbackError) {
        return this.handleAppError(rollbackError, appUrn, 'update_error');
      }
      const failure = await this.handleAppError(error, appUrn, 'update_error');
      return { ...failure, statePreserved: true, updateStatus: previous?.status };
    } finally {
      await migrations?.close().catch(() => undefined);
      await plan?.release().catch(() => undefined);
      if (transaction instanceof AppUpdateStage) await transaction.close().catch(() => undefined);
    }
  }
}
