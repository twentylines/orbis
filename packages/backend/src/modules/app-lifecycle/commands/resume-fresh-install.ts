import { resumeFreshPreparation } from './resume-fresh-preparation';
import dotenv from 'dotenv';
import { appUpdateStorage } from '../../docker/app-image-pins';
import { TasksService } from '../../tasks/tasks.service';
import type { TaskPhase } from '@runtipi/common/schemas/task-history';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import type { AppUrn } from '@runtipi/common/types';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppFilesManager } from '../../apps/app-files-manager';
import { AppsRepository } from '../../apps/apps.repository';
import { freshInstallFailure, freshInstallResultBinding, type FreshInstallResult } from '../../apps/app-fresh-commit';
import { BackupManager } from '../../backups/backup.manager';
import { DockerService } from '../../docker/docker.service';
import { AppUpdateStage } from '../../docker/app-update-stage';
import { FreshAppStorage } from '../../docker/app-fresh-storage';
import { hasInstallRequestHold, reopenSpentInstallRequest } from '../install-request-receipt';
import { readFreshInstallResult, retainFreshInstallResult } from '../install-result';
import type { AppEventFormInput, appEventResultSchema } from '../../queue/entities/app-events';
import { requestInputHash } from './update-app-command';

export async function completeFreshInstall(input: {
  dataDir: string;
  stage: AppUpdateStage;
  storage: FreshAppStorage;
  repository: AppsRepository;
  verifyRequest: () => Promise<void>;
  isCurrent: () => Promise<boolean>;
}) {
  const stage = input.stage;
  await stage.commit(async () => {
    const result = await freshInstallResultBinding(stage);
    await input.verifyRequest();
    await input.storage.verify(stage, result.status === 'running');
    if (!(await input.isCurrent())) throw freshInstallFailure();
    // An immutable local intent survives guard removal and later spent-receipt cleanup.
    await retainFreshInstallResult(input.dataDir, result);
    await input.verifyRequest();
    await input.repository.commitFreshInstall(stage, result).catch(() => undefined);
    // A missing acknowledgement never permits a repeated SQL update or an app restart.
    if (!(await input.repository.readCurrentFreshInstallCommit(result))) throw freshInstallFailure();
  });
}

/** Continues only the saved fresh request and immutable image plan. Durable effect intents prevent repeating uncertain create/start/SQL. */
export async function reconcileFreshInstall(input: {
  moduleRef: ModuleRef;
  docker: Dockerode;
  appUrn: AppUrn;
  requestId: string;
  form: AppEventFormInput;
}): Promise<typeof appEventResultSchema.infer | undefined> {
  let stage: AppUpdateStage | undefined;
  let storage: FreshAppStorage | undefined;
  let plan: Awaited<ReturnType<DockerService['prepareResumedAppUpdate']>> | undefined;
  try {
    const dataDir = input.moduleRef.get(ConfigurationService, { strict: false }).get('directories').dataDir;
    const repository = input.moduleRef.get(AppsRepository, { strict: false });
    const service = input.moduleRef.get(DockerService, { strict: false });
    const saved = await readFreshInstallResult(dataDir, input.appUrn, input.requestId);
    const custody = await reopenSpentInstallRequest(dataDir, input.appUrn, input.requestId);
    if (!saved && !custody) return;
    if (await input.moduleRef.get(BackupManager, { strict: false }).hasPendingRestore(input.appUrn)) return;
    const matches = async (result: FreshInstallResult) => {
      if (result.requestInputSha256 !== requestInputHash(input.form) || (result.status === 'stopped') !== (input.form.skipRun === true))
        throw freshInstallFailure();
      if (!custody) return;
      await custody.verify();
      const row = custody.reservation;
      if (
        row &&
        (row.id !== result.appId ||
          row.createdAt !== result.appCreatedAt ||
          row.version !== result.version ||
          custody.skipRun !== (result.status === 'stopped'))
      )
        throw freshInstallFailure();
    };
    if (saved) {
      await matches(saved);
      if (!(await repository.readFreshInstallCommit(saved))) return;
      const guard = await service.readAppImageUpdateGuard(input.appUrn);
      if (guard) {
        if (guard.version !== 2 || guard.id !== saved.stageId || guard.requestId !== saved.requestId || !custody?.reservation) return;
        stage = (await service.reopenStagedAppUpdate(input.appUrn, input.requestId, saved.stageId)).transaction;
        if (JSON.stringify(await freshInstallResultBinding(stage)) !== JSON.stringify(saved)) throw freshInstallFailure();
        await stage.reconcileFreshCommitted(repository);
      } else if (!custody && (await hasInstallRequestHold(dataDir, input.appUrn))) return;
      await custody?.retire();
      return { success: true, alreadyCompleted: true, updateStatus: saved.status, message: 'The saved app installation is complete.' };
    }
    if (!custody?.reservation) return;
    stage = (await service.reopenStagedAppUpdate(input.appUrn, input.requestId)).transaction;
    let state = await stage.read();
    if (!state.context) {
      await resumeFreshPreparation({ ...input, stage, reservation: custody.reservation, verifyCustody: custody.verify });
      state = await stage.read();
    }
    const context = state.context;
    const reservation = custody.reservation;
    if (
      !context ||
      context.purpose !== 'fresh-install' ||
      context.appId !== reservation.id ||
      context.appCreatedAt !== reservation.createdAt ||
      context.fromVersion !== reservation.version ||
      context.toVersion !== reservation.version ||
      context.requestInputSha256 !== requestInputHash(input.form) ||
      (context.updateStatus === 'stopped') !== (input.form.skipRun === true) ||
      custody.skipRun !== (input.form.skipRun === true)
    )
      throw freshInstallFailure();
    const report = async (phase: TaskPhase) => {
      try {
        await input.moduleRef
          .get(TasksService, { strict: false })
          .progress({ command: 'install', appUrn: input.appUrn, requestId: input.requestId }, phase);
      } catch {
        /* Reporting never authorizes an install effect. */
      }
    };
    const verifyRequest = async () => {
      await custody.verify();
      const current = await repository.getAppByUrn(input.appUrn);
      if (
        !current ||
        current.id !== reservation.id ||
        current.createdAt !== reservation.createdAt ||
        current.version !== reservation.version ||
        current.appName !== reservation.appName ||
        current.appStoreSlug !== reservation.appStoreSlug ||
        !['installing', 'stopped'].includes(current.status)
      )
        throw freshInstallFailure();
    };
    if (['committing', 'commit-verified'].includes(state.phase)) {
      const result = await freshInstallResultBinding(stage);
      await matches(result);
      if (!(await repository.readCurrentFreshInstallCommit(result))) throw freshInstallFailure();
      await retainFreshInstallResult(dataDir, result);
      await stage.reconcileFreshCommitted(repository);
      await custody.retire();
      return { success: true, alreadyCompleted: true, updateStatus: result.status, message: 'The saved app installation is complete.' };
    }
    await verifyRequest();
    if (!['target-ready', 'switching', 'prepared', 'activation-attempted'].includes(state.phase)) throw freshInstallFailure();
    await report('preparing');
    const storageInput = {
      appUrn: input.appUrn,
      localDirectory: input.moduleRef.get(AppFilesManager, { strict: false }).getAppPaths(input.appUrn).appDataDir,
      socketPath: process.env.ORBIS_HOST_SOCKET ?? '',
      docker: input.docker,
    };
    storage = state.freshInstall
      ? await FreshAppStorage.reopen(storageInput, stage)
      : state.freshPreparation
        ? await FreshAppStorage.reopenPreparation({ ...storageInput }, stage, true)
        : await FreshAppStorage.open(storageInput);
    if (!state.freshInstall) {
      if (state.phase !== 'target-ready') throw freshInstallFailure();
      await storage.initialize(stage);
      state = await stage.read();
    }
    await service.verifyFreshInstallInputs(input.appUrn, stage);
    const prepare = async () => {
      if (!plan) plan = await service.prepareResumedAppUpdate(input.appUrn, stage as AppUpdateStage, input.docker, { freshInstall: true });
      if (!(await plan.isCurrent())) throw freshInstallFailure();
      return plan;
    };
    if (state.freshInstall?.phase === 'allocating') {
      const ledger = await repository.getMigrationLedger(context.appId);
      if (ledger.baselined || ledger.migrationIds.length) throw freshInstallFailure();
      const selected = await prepare();
      const effective = await selected.freshConfiguration();
      if (
        context.updateStatus === 'running' &&
        (!Array.isArray(effective['x-orbis-fresh-active-services']) || !effective['x-orbis-fresh-active-services'].length)
      )
        throw freshInstallFailure();
      if (!state.freshInstall.createAttempted) {
        const target = await stage.readTarget();
        const environment = new Map(Object.entries(dotenv.parse(await appUpdateStorage.readOwned(target.env, 1024 * 1024))));
        if (state.freshInstall.seed === 'pending') {
          await storage.allocate(stage, effective);
          await storage.seed(stage, environment);
        }
        await storage.verifySeed(stage, environment);
        await verifyRequest();
        if (!(await selected.isCurrent())) throw freshInstallFailure();
        await report('publishing');
        await stage.publishTarget();
        await selected.createFresh(stage).catch(() => undefined);
      }
      // A recorded create may only be acknowledged from complete never-started containers, never issued again.
      await storage.prepared(stage, effective);
      state = await stage.read();
    }
    if (state.freshInstall?.phase === 'prepared') {
      await storage.verify(stage, false);
      await verifyRequest();
      await service.verifyFreshInstallInputs(input.appUrn, stage);
      const ledger = await repository.getMigrationLedger(context.appId);
      if (ledger.baselined || ledger.migrationIds.length) throw freshInstallFailure();
      await stage.beginFreshBaseline();
      await repository.commitFreshInstallBaseline(stage).catch(() => undefined);
      state = await stage.read();
    }
    if (state.freshInstall?.phase === 'baseline-intent' || state.freshInstall?.phase === 'baselined') {
      await stage.confirmFreshBaseline(repository);
      state = await stage.read();
    }
    if (state.freshInstall?.phase !== 'baselined') throw freshInstallFailure();
    if (state.phase === 'prepared') {
      await storage.verify(stage, false);
      await verifyRequest();
      await service.verifyFreshInstallInputs(input.appUrn, stage);
      await stage.pinFreshImages(await service.getAppImagePinSource(input.appUrn, stage.id));
      if (context.updateStatus === 'running') {
        const selected = await prepare();
        await verifyRequest();
        await report('starting');
        await stage.activationAttempted();
        await selected.activate().catch(() => undefined);
      }
    }
    await report('verifying');
    await storage.verify(stage, context.updateStatus === 'running');
    await verifyRequest();
    await service.verifyFreshInstallInputs(input.appUrn, stage);
    await report('committing');
    await completeFreshInstall({
      dataDir,
      stage,
      storage,
      repository,
      verifyRequest,
      isCurrent: async () => {
        await service.verifyFreshInstallInputs(input.appUrn, stage as AppUpdateStage);
        return true;
      },
    });
    await custody.retire();
    return { success: true, alreadyCompleted: true, updateStatus: context.updateStatus, message: 'The saved app installation is complete.' };
  } catch {
    return;
  } finally {
    await plan?.release().catch(() => undefined);
    await storage?.close().catch(() => undefined);
    await stage?.close().catch(() => undefined);
  }
}
