import { resumeExistingAppBaseline } from './resume-existing-app-baseline';
import { captureStoppedAppBackup } from './capture-stopped-app-backup';
import path from 'node:path';
import { ConfigurationService } from '@/core/config/configuration.service';
import { AppUpdateMigrations } from '../../docker/app-update-migrations';
import type { AppMigrationJournal } from '../../backups/app-migration-journal';
import type { ModuleRef } from '@nestjs/core';
import type { AppUrn } from '@runtipi/common/types';
import type { TaskPhase } from '@runtipi/common/schemas/task-history';
import type Dockerode from 'dockerode';
import { AppsRepository } from '../../apps/apps.repository';
import { DockerService } from '../../docker/docker.service';
import type { AppUpdateStage } from '../../docker/app-update-stage';
import type { AppEventFormInput, appEventResultSchema } from '../../queue/entities/app-events';
import { resumeMigratingAppUpdate } from './resume-app-migrations';
import { requestInputHash } from './update-app-command';
import { currentContainers, originalStopped, stopOriginalUpdateRuntime, verifyAppUpdateRuntime } from './app-update-runtime';

const recovery = () => new Error('This interrupted app update needs recovery. Its saved files and any new app writes were kept.');
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Reopens the recorded request and saved target images. Only explicitly unallocated migration preparation may select its first images. */
export async function resumeAppUpdate(input: {
  moduleRef: ModuleRef;
  docker: Dockerode;
  appUrn: AppUrn;
  requestId: string;
  form: AppEventFormInput;
  performBackup?: boolean;
  report: (phase: TaskPhase) => Promise<void>;
}): Promise<typeof appEventResultSchema.infer> {
  const service = input.moduleRef.get(DockerService, { strict: false });
  const repository = input.moduleRef.get(AppsRepository, { strict: false });
  let stage: AppUpdateStage | undefined;
  let plan: Awaited<ReturnType<DockerService['prepareResumedAppUpdate']>> | undefined;
  try {
    stage = (await service.reopenStagedAppUpdate(input.appUrn, input.requestId)).transaction;
    let state = await stage.read();
    if (!state.context && state.existingBaseline) {
      await resumeExistingAppBaseline({ ...input, stage });
      state = await stage.read();
    }
    const context = state.context;
    if (
      !context ||
      context.purpose !== undefined ||
      !state.pulledImages ||
      context.requestInputSha256 !== requestInputHash(input.form) ||
      (state.phase === 'activation-attempted' && context.updateStatus !== 'running')
    )
      throw recovery();
    if (context.targetMigrationIds.some((id) => !context.previousLedger.migrationIds.includes(id)))
      return await resumeMigratingAppUpdate({
        moduleRef: input.moduleRef,
        docker: input.docker,
        appUrn: input.appUrn,
        stage,
        report: input.report,
        performBackup: input.performBackup,
      });
    if (['committing', 'commit-verified'].includes(state.phase)) {
      await stage.reconcileOrdinaryCommitted(repository);
      return { success: true, alreadyCompleted: true, message: 'This app update has already committed.' };
    }
    if (!['target-ready', 'switching', 'prepared', 'activation-attempted'].includes(state.phase)) throw recovery();
    const installed = await repository.getAppByUrn(input.appUrn);
    if (
      !installed ||
      installed.id !== context.appId ||
      installed.createdAt !== context.appCreatedAt ||
      installed.version !== context.fromVersion ||
      installed.status !== 'updating'
    )
      throw recovery();
    const ledger = await repository.getMigrationLedger(installed.id);
    if (
      !equal(ledger, context.previousLedger) ||
      (!ledger.baselined && (ledger.migrationIds.length || context.targetMigrationIds.length)) ||
      context.targetMigrationIds.some((id) => !ledger.migrationIds.includes(id))
    )
      throw recovery();
    // A migration-bearing operation must enter through its journal/checkpoint/SQL coordinator instead.
    await input.report('preparing');
    plan = await service.prepareResumedAppUpdate(input.appUrn, stage, input.docker);
    if (!(await plan.isCurrent())) throw recovery();
    if (state.phase === 'target-ready') {
      await input.report('stopping');
      await stopOriginalUpdateRuntime(input.docker, input.appUrn, context);
      if (input.performBackup) {
        await input.report('backing_up');
        await captureStoppedAppBackup(input.moduleRef, input.appUrn);
      }
    }
    if (state.phase === 'target-ready' || state.phase === 'switching') {
      originalStopped(await currentContainers(input.docker, input.appUrn), context);
      if (!(await plan.isCurrent())) throw recovery();
      await input.report('publishing');
      await stage.publishTarget();
    }
    if ((await stage.read()).phase === 'prepared') {
      originalStopped(await currentContainers(input.docker, input.appUrn), context);
      if (context.updateStatus === 'running') {
        await stage.activationAttempted();
        await input.report('starting');
        // The activation intent is durable. Verify the exact target below even
        // if Compose loses its reply, without sending another activation.
        await plan.activate().catch(() => undefined);
      }
    }
    await input.report('verifying');
    await verifyAppUpdateRuntime(input.docker, input.appUrn, context, stage.id, state.pulledImages.imageIds);
    if (!(await plan.isCurrent())) throw recovery();
    await input.report('committing');
    await stage.commitOrdinary(repository, context.updateStatus === 'running' ? false : null);
    return { success: true, message: `App ${input.appUrn} update resumed successfully`, updateStatus: context.updateStatus };
  } catch {
    await stage?.close().catch(() => undefined);
    stage = undefined;
    return (await reconcileAppUpdateCommit(input)) ?? { success: false, message: recovery().message };
  } finally {
    await plan?.release().catch(() => undefined);
    await stage?.close().catch(() => undefined);
  }
}

/** A failed response may hide a committed SQL transaction. This entry can only clear its positive exact receipt; it cannot activate or write SQL. */
export async function reconcileAppUpdateCommit(input: {
  moduleRef: ModuleRef;
  appUrn: AppUrn;
  requestId: string;
  form: AppEventFormInput;
}): Promise<typeof appEventResultSchema.infer | undefined> {
  let stage: AppUpdateStage | undefined;
  let journal: AppMigrationJournal | undefined;
  try {
    stage = (await input.moduleRef.get(DockerService, { strict: false }).reopenStagedAppUpdate(input.appUrn, input.requestId)).transaction;
    const state = await stage.read();
    const context = state.context;
    if (
      !context ||
      context.purpose !== undefined ||
      context.requestInputSha256 !== requestInputHash(input.form) ||
      !['committing', 'commit-verified'].includes(state.phase)
    )
      return;
    if (!context.targetMigrationIds.some((id) => !context.previousLedger.migrationIds.includes(id))) {
      await stage.reconcileOrdinaryCommitted(input.moduleRef.get(AppsRepository, { strict: false }));
      return { success: true, alreadyCompleted: true, message: 'This app update has already committed.' };
    }
    const config = input.moduleRef.get(ConfigurationService, { strict: false });
    journal = await AppUpdateMigrations.openJournal(stage, path.join(config.get('directories').dataDir, 'state', 'orbis-app-migrations'));
    await stage.reconcileCommitted(journal, input.moduleRef.get(AppsRepository, { strict: false }));
    return { success: true, alreadyCompleted: true, message: 'This app migration has already committed.' };
  } catch {
    try {
      const service = input.moduleRef.get(DockerService, { strict: false });
      const saved = await service.readCompletedOrdinaryAppUpdate(input.appUrn, input.requestId);
      if (!saved || saved.requestInputSha256 !== requestInputHash(input.form)) return;
      if (!(await input.moduleRef.get(AppsRepository, { strict: false }).readCurrentOrdinaryUpdateCommit(saved))) return;
      return { success: true, alreadyCompleted: true, message: 'This app update has already committed.' };
    } catch {
      return;
    }
  } finally {
    await journal?.close().catch(() => undefined);
    await stage?.close().catch(() => undefined);
  }
}
