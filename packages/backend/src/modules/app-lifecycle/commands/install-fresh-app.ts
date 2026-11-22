import { completeFreshInstall } from './resume-fresh-install';
import fs, { constants } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import type Dockerode from 'dockerode';
import type { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@runtipi/common/types';
import { dynamicComposeSchemaYaml } from '@runtipi/common/schemas';
import type { TaskPhase } from '@runtipi/common/schemas/task-history';
import { type } from 'arktype';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppFilesManager } from '../../apps/app-files-manager';
import { AppHelpers } from '../../apps/app.helpers';
import { AppsRepository } from '../../apps/apps.repository';
import { DockerService } from '../../docker/docker.service';
import { DockerComposeBuilder } from '../../docker/builders/compose.builder';
import { FreshAppStorage, freshInstallCandidate } from '../../docker/app-fresh-storage';
import { AppUpdateStage } from '../../docker/app-update-stage';
import { MarketplaceService } from '../../marketplace/marketplace.service';
import { SubnetManagerService } from '../../network/subnet-manager.service';
import { verifyInstallRequestOwnership, type InstallRequestOwnership } from '../install-request-receipt';
import type { AppEventFormInput, appEventResultSchema } from '../../queue/entities/app-events';
import { requestInputHash } from './update-app-command';

const fail = () => new Error('The fresh app install needs verified recovery. Its package, data and operation records were kept.');
async function directory(name: string, mode: number) {
  if (!path.isAbsolute(name) || path.resolve(name) !== name) throw fail();
  const handles: { name: string; handle: Awaited<ReturnType<typeof fs.open>> }[] = [];
  try {
    let current = '/';
    handles.push({ name: current, handle: await fs.open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) });
    for (const part of name.split('/').filter(Boolean)) {
      const parent = handles.at(-1);
      if (!parent) throw fail();
      current = path.join(current, part);
      const selected = process.platform === 'linux' ? `/proc/self/fd/${parent.handle.fd}/${part}` : current;
      await fs.mkdir(selected, { mode: current === name ? mode : 0o750 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      handles.push({ name: current, handle: await fs.open(selected, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) });
    }
    const last = handles.at(-1);
    if (!last) throw fail();
    await last.handle.chmod(mode);
    for (const entry of handles) {
      const stat = await entry.handle.stat();
      const named = await fs.lstat(entry.name);
      if (!named.isDirectory() || stat.dev !== named.dev || stat.ino !== named.ino) throw fail();
    }
  } finally {
    await Promise.all(handles.map(({ handle }) => handle.close()));
  }
}

/** Real fresh installs only. Retained data stays on the existing non-baselining path until its history is positively known. */
export async function installFreshApp(input: {
  moduleRef: ModuleRef;
  docker: Dockerode;
  appUrn: AppUrn;
  requestId: string;
  ownership: InstallRequestOwnership;
  form: AppEventFormInput;
  report: (phase: TaskPhase) => Promise<void>;
  error: (error: unknown) => Promise<{ success: false; message: string }>;
}): Promise<typeof appEventResultSchema.infer | undefined> {
  const files = input.moduleRef.get(AppFilesManager, { strict: false });
  const paths = files.getAppPaths(input.appUrn);
  if (!paths || !(await freshInstallCandidate([paths.appInstalledDir, paths.appDataDir]))) return undefined;
  const repository = input.moduleRef.get(AppsRepository, { strict: false });
  const docker = input.moduleRef.get(DockerService, { strict: false });
  const config = input.moduleRef.get(ConfigurationService, { strict: false });
  const subnets = input.moduleRef.get(SubnetManagerService, { strict: false });
  let changed = false;
  let stage: AppUpdateStage | undefined;
  let storage: FreshAppStorage | undefined;
  let plan: Awaited<ReturnType<DockerService['prepareStagedAppUpdate']>> | undefined;
  const owned = async () => {
    const receipt = await verifyInstallRequestOwnership(input.ownership, input.appUrn, input.requestId);
    const app = await repository.getAppByUrn(input.appUrn);
    if (
      receipt.version === undefined ||
      input.ownership.skipRun !== (input.form.skipRun === true) ||
      !app ||
      app.id !== receipt.id ||
      app.createdAt !== receipt.createdAt ||
      app.appName !== receipt.appName ||
      app.appStoreSlug !== receipt.appStoreSlug ||
      app.version !== receipt.version ||
      app.status !== 'installing'
    )
      throw fail();
    return app;
  };
  try {
    const app = await owned();
    const ledger = await repository.getMigrationLedger(app.id);
    if (ledger.baselined || ledger.migrationIds.length || app.migrationsBaselined) throw fail();
    await input.report('preparing');
    changed = true;
    await directory(paths.appInstalledDir, 0o750);
    await directory(paths.appDataDir, 0o777);
    // The Host co-references the actual controller mount, namespace, daemon and physical empty app root.
    storage = await FreshAppStorage.open({
      appUrn: input.appUrn,
      localDirectory: paths.appDataDir,
      socketPath: process.env.ORBIS_HOST_SOCKET ?? '',
      docker: input.docker,
    });
    const selected = await docker.beginStagedAppUpdate(input.appUrn, input.requestId, {
      appId: app.id,
      appCreatedAt: app.createdAt,
      version: app.version,
      requestInputSha256: requestInputHash(input.form),
      ...(await storage.capturePreparation()),
    });
    if (selected.retained || !(selected.transaction instanceof AppUpdateStage)) throw fail();
    stage = selected.transaction;
    await input.moduleRef.get(MarketplaceService, { strict: false }).stageAppUpdate(input.appUrn, stage.targetDirectory);
    const info = await files.getInstalledAppInfo(input.appUrn, stage.targetDirectory);
    const source = await files.getSourceDockerComposeYaml(input.appUrn, stage.targetDirectory);
    const compose = dynamicComposeSchemaYaml(source.content);
    if (!info || info.tipi_version !== app.version || compose instanceof type.errors) throw fail();
    const environment = await input.moduleRef.get(AppHelpers, { strict: false }).renderAppEnv(input.appUrn, info, input.form);
    const subnet = await subnets.planUpdateSubnet(input.appUrn, app.subnet);
    await stage.recordFreshSubnet(subnet);
    await stage.stageTarget(
      new DockerComposeBuilder().getDockerCompose(compose, input.form, input.appUrn, subnet, config.get('architecture')),
      environment,
    );
    const targetMigrationIds = await files.getAppMigrationIds(input.appUrn, stage.targetDirectory);
    plan = await docker.prepareStagedAppUpdate(input.appUrn, stage.id, input.docker, { freshInstall: true, stage });
    await stage.recordFreshPullPlan(plan.inputsSha256, await plan.freshPullConfiguration());
    await input.report('pulling_images');
    await stage.recordPulledImages(await plan.pull());
    await owned();
    if (!(await plan.isCurrent())) throw fail();
    await subnets.reserveUpdateSubnet(input.appUrn, app.subnet, subnet);
    await stage.recordContext({
      purpose: 'fresh-install',
      appId: app.id,
      appCreatedAt: app.createdAt,
      fromVersion: app.version,
      toVersion: app.version,
      requestInputSha256: requestInputHash(input.form),
      authoritySha256: plan.inputsSha256,
      previousLedger: ledger,
      targetMigrationIds,
      updateStatus: input.form.skipRun ? 'stopped' : 'running',
      originalContainers: [],
    });
    await storage.initialize(stage);
    const effective = await plan.freshConfiguration();
    if (!input.form.skipRun && (!Array.isArray(effective['x-orbis-fresh-active-services']) || !effective['x-orbis-fresh-active-services'].length))
      throw fail();
    // Check all volume/bind dispositions before copying any seed data or creating containers.
    await storage.allocate(stage, effective);
    await storage.seed(stage, new Map(Object.entries(dotenv.parse(environment))));
    await owned();
    if (!(await plan.isCurrent())) throw fail();
    await input.report('publishing');
    await stage.publishTarget();
    // A failed client reply does not establish whether Compose created the containers.
    // Verify the exact recorded allocation once; never issue create again.
    await plan.createFresh(stage).catch(() => undefined);
    await storage.prepared(stage, effective);
    await storage.verify(stage, false);
    await owned();
    if (!(await plan.isCurrent())) throw fail();
    await stage.beginFreshBaseline();
    // One SQL attempt only. A lost reply may be reconciled by the exact current baseline; it is never blindly retried.
    await repository.commitFreshInstallBaseline(stage).catch(() => undefined);
    await stage.confirmFreshBaseline(repository);
    await storage.verify(stage, false);
    await stage.pinFreshImages(await docker.getAppImagePinSource(input.appUrn, stage.id));
    if (!input.form.skipRun) {
      await owned();
      if (!(await plan.isCurrent())) throw fail();
      await input.report('starting');
      await stage.activationAttempted();
      // The runtime readback below decides the outcome even if the client lost its reply.
      // The durable start intent prevents an uncertain start from being repeated.
      await plan.activate().catch(() => undefined);
    }
    await input.report('verifying');
    await storage.verify(stage, !input.form.skipRun);
    await owned();
    if (!(await plan.isCurrent())) throw fail();
    await input.report('committing');
    await completeFreshInstall({
      dataDir: config.get('directories').dataDir,
      stage,
      storage,
      repository,
      verifyRequest: async () => {
        await owned();
      },
      isCurrent: plan.isCurrent,
    });
    return {
      success: true,
      updateStatus: input.form.skipRun ? 'stopped' : 'running',
      message: `App ${input.appUrn} installed successfully${input.form.skipRun ? ' (skipped run)' : ''}`,
    };
  } catch (error) {
    // No rollback/deletion can manufacture a fresh baseline after an uncertain SQL or first-start effect.
    return { ...(await input.error(error)), statePreserved: !changed };
  } finally {
    await plan?.release().catch(() => undefined);
    await storage?.close().catch(() => undefined);
    await stage?.close().catch(() => undefined);
  }
}
