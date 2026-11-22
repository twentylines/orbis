import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import type { AppUrn } from '@runtipi/common/types';
import { AppFilesManager } from '../../apps/app-files-manager';
import { AppsRepository } from '../../apps/apps.repository';
import { ExistingAppBaseline, verifyExistingAppBaseline } from '../../docker/app-existing-storage';
import type { AppUpdateStage } from '../../docker/app-update-stage';
import { DockerService } from '../../docker/docker.service';
import type { AppEventFormInput } from '../../queue/entities/app-events';
import { requestInputHash } from './update-app-command';
const recovery = () => new Error('This app update starting point needs recovery. Its saved files and data were kept.');

/** Read-only SQL acknowledgement and a fresh live proof. This cannot repeat an uncertain baseline transaction. */
export async function resumeExistingAppBaseline(input: {
  moduleRef: ModuleRef;
  docker: Dockerode;
  appUrn: AppUrn;
  stage: AppUpdateStage;
  form: AppEventFormInput;
}) {
  const state = await input.stage.read();
  const binding = state.existingBaseline?.binding;
  if (
    state.phase !== 'target-ready' ||
    state.context ||
    !binding ||
    binding.appUrn !== input.appUrn ||
    binding.requestInputSha256 !== requestInputHash(input.form)
  )
    throw recovery();
  const repository = input.moduleRef.get(AppsRepository, { strict: false });
  const files = input.moduleRef.get(AppFilesManager, { strict: false });
  const app = await repository.getAppByUrn(input.appUrn);
  if (!app || app.id !== binding.appId || app.createdAt !== binding.appCreatedAt || app.version !== binding.version || app.status !== 'updating')
    throw recovery();
  const proof = await ExistingAppBaseline.reopen({
    stage: input.stage,
    service: input.moduleRef.get(DockerService, { strict: false }),
    docker: input.docker,
    appUrn: input.appUrn,
    localDirectory: files.getAppPaths(input.appUrn).appDataDir,
    socketPath: process.env.ORBIS_HOST_SOCKET ?? '',
    appId: app.id,
    appCreatedAt: app.createdAt,
    version: app.version,
    requestInputSha256: requestInputHash(input.form),
    originalContainers: binding.originalContainers.map(({ id, imageId, service, running, paused, restarting }) => ({
      id,
      imageId,
      service,
      running,
      paused,
      restarting,
    })),
  });
  try {
    const previousLedger = await input.stage.confirmExistingBaseline(repository);
    const target = await input.stage.readTarget();
    const [info, targetMigrationIds] = await Promise.all([
      files.getInstalledAppInfo(input.appUrn, target.target),
      files.getAppMigrationIds(input.appUrn, target.target),
    ]);
    if (!info) throw recovery();
    await verifyExistingAppBaseline(proof, input.stage);
    await input.stage.recordContext({
      appId: app.id,
      appCreatedAt: app.createdAt,
      fromVersion: app.version,
      toVersion: info.tipi_version,
      requestInputSha256: binding.requestInputSha256,
      authoritySha256: binding.authoritySha256,
      previousLedger,
      targetMigrationIds,
      updateStatus: binding.originalContainers.some((row) => row.running || row.paused || row.restarting) ? 'running' : 'stopped',
      originalContainers: binding.originalContainers.map(({ id, imageId, service, running, paused, restarting }) => ({
        id,
        imageId,
        service,
        running,
        paused,
        restarting,
      })),
    });
  } finally {
    await proof.close();
  }
}
