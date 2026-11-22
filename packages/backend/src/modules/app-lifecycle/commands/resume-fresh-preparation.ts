import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import type { AppUrn } from '@runtipi/common/types';
import { AppFilesManager } from '../../apps/app-files-manager';
import { AppsRepository, type InstallAppReservation } from '../../apps/apps.repository';
import { freshInstallFailure } from '../../apps/app-fresh-commit';
import { AppUpdateStage } from '../../docker/app-update-stage';
import { DockerService } from '../../docker/docker.service';
import { FreshAppStorage } from '../../docker/app-fresh-storage';
import { SubnetManagerService } from '../../network/subnet-manager.service';
import { TasksService } from '../../tasks/tasks.service';
import type { AppEventFormInput } from '../../queue/entities/app-events';
import { requestInputHash } from './update-app-command';

/** The saved target and pre-pull selection belong to this same still-owned clean installation. */
export async function resumeFreshPreparation(input: {
  moduleRef: ModuleRef;
  docker: Dockerode;
  stage: AppUpdateStage;
  appUrn: AppUrn;
  requestId: string;
  form: AppEventFormInput;
  reservation: InstallAppReservation;
  verifyCustody: () => Promise<void>;
}) {
  const state = await input.stage.read();
  const preparation = state.freshPreparation;
  const reservation = input.reservation;
  if (
    !preparation ||
    state.appUrn !== input.appUrn ||
    state.requestId !== input.requestId ||
    state.context ||
    state.phase !== 'target-ready' ||
    !state.prepared ||
    !preparation.subnet ||
    preparation.appId !== reservation.id ||
    preparation.appCreatedAt !== reservation.createdAt ||
    preparation.version !== reservation.version ||
    preparation.requestInputSha256 !== requestInputHash(input.form)
  )
    throw freshInstallFailure();
  const repository = input.moduleRef.get(AppsRepository, { strict: false });
  const service = input.moduleRef.get(DockerService, { strict: false });
  const files = input.moduleRef.get(AppFilesManager, { strict: false });
  const verify = async () => {
    await input.verifyCustody();
    const app = await repository.getAppByUrn(input.appUrn);
    const ledger = await repository.getMigrationLedger(preparation.appId);
    if (
      !app ||
      app.id !== preparation.appId ||
      app.createdAt !== preparation.appCreatedAt ||
      app.version !== preparation.version ||
      app.appName !== reservation.appName ||
      app.appStoreSlug !== reservation.appStoreSlug ||
      !['installing', 'stopped'].includes(app.status) ||
      app.migrationsBaselined ||
      ledger.baselined ||
      ledger.migrationIds.length ||
      (app.subnet !== null && app.subnet !== preparation.subnet)
    )
      throw freshInstallFailure();
    return app;
  };
  await verify();
  const storage = await FreshAppStorage.reopenPreparation(
    {
      appUrn: input.appUrn,
      docker: input.docker,
      localDirectory: files.getAppPaths(input.appUrn).appDataDir,
      socketPath: process.env.ORBIS_HOST_SOCKET ?? '',
    },
    input.stage,
  );
  let plan: Awaited<ReturnType<DockerService['prepareStagedAppUpdate']>> | undefined;
  try {
    const target = await input.stage.readTarget();
    const info = await files.getInstalledAppInfo(input.appUrn, target.target);
    if (!info || info.tipi_version !== preparation.version) throw freshInstallFailure();
    const targetMigrationIds = await files.getAppMigrationIds(input.appUrn, target.target);
    plan = await service.prepareStagedAppUpdate(input.appUrn, input.stage.id, input.docker, { freshInstall: true, stage: input.stage });
    await input.stage.recordFreshPullPlan(plan.inputsSha256, await plan.freshPullConfiguration());
    if (!state.pulledImages) {
      try {
        await input.moduleRef
          .get(TasksService, { strict: false })
          .progress({ command: 'install', appUrn: input.appUrn, requestId: input.requestId }, 'pulling_images');
      } catch {
        /* Reporting has no install authority. */
      }
      await input.stage.recordPulledImages(await plan.pull());
    }
    const current = await verify();
    if (!(await plan.isCurrent())) throw freshInstallFailure();
    await input.moduleRef.get(SubnetManagerService, { strict: false }).reserveUpdateSubnet(input.appUrn, current.subnet, preparation.subnet);
    await input.stage.recordContext({
      purpose: 'fresh-install',
      appId: preparation.appId,
      appCreatedAt: preparation.appCreatedAt,
      fromVersion: preparation.version,
      toVersion: preparation.version,
      requestInputSha256: preparation.requestInputSha256,
      authoritySha256: plan.inputsSha256,
      previousLedger: { baselined: false, migrationIds: [] },
      targetMigrationIds,
      updateStatus: input.form.skipRun === true ? 'stopped' : 'running',
      originalContainers: [],
    });
  } finally {
    await plan?.release().catch(() => undefined);
    await storage.close();
  }
}
