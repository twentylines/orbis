import { captureStoppedAppBackup } from './capture-stopped-app-backup';
import { AppMigrationJournal as MigrationJournal } from '../../backups/app-migration-journal';
import path from 'node:path';
import type { ModuleRef } from '@nestjs/core';
import type Dockerode from 'dockerode';
import type { AppUrn } from '@runtipi/common/types';
import type { TaskPhase } from '@runtipi/common/schemas/task-history';
import { ConfigurationService } from '@/core/config/configuration.service';
import { ArchiveService } from '@/core/archive/archive.service';
import { AppFilesManager } from '../../apps/app-files-manager';
import { AppsRepository } from '../../apps/apps.repository';
import { AppUpdateMigrations } from '../../docker/app-update-migrations';
import type { AppMigrationJournal } from '../../backups/app-migration-journal';
import type { AppUpdateStage } from '../../docker/app-update-stage';
import { DockerService } from '../../docker/docker.service';
import type { appEventResultSchema } from '../../queue/entities/app-events';
import { rollbackMigratingAppUpdate } from './rollback-app-update';
import { currentContainers, originalStopped, stopOriginalUpdateRuntime, verifyAppUpdateRuntime } from './app-update-runtime';

const recovery = () => new Error('The interrupted app migration needs verified recovery. Its data and saved operation records were kept.');
export async function resumeMigratingAppUpdate(input: {
  moduleRef: ModuleRef;
  docker: Dockerode;
  appUrn: AppUrn;
  stage: AppUpdateStage;
  performBackup?: boolean;
  report: (phase: TaskPhase) => Promise<void>;
}): Promise<typeof appEventResultSchema.infer> {
  const repository = input.moduleRef.get(AppsRepository, { strict: false });
  const service = input.moduleRef.get(DockerService, { strict: false });
  const config = input.moduleRef.get(ConfigurationService, { strict: false });
  const journalRoot = path.join(config.get('directories').dataDir, 'state', 'orbis-app-migrations');
  let migrations: AppUpdateMigrations | undefined;
  let journal: AppMigrationJournal | undefined;
  let plan: Awaited<ReturnType<DockerService['prepareResumedAppUpdate']>> | undefined;
  try {
    const state = await input.stage.read();
    const context = state.context;
    if (!context || !state.pulledImages) throw recovery();
    if (['committing', 'commit-verified'].includes(state.phase)) {
      journal = await AppUpdateMigrations.openJournal(input.stage, journalRoot);
      await input.stage.reconcileCommitted(journal, repository);
      return { success: true, alreadyCompleted: true, message: 'This app migration has already committed.' };
    }
    const app = await repository.getAppByUrn(input.appUrn);
    if (
      !app ||
      app.id !== context.appId ||
      app.createdAt !== context.appCreatedAt ||
      app.version !== context.fromVersion ||
      !['updating', ...(state.rollback ? [context.updateStatus] : [])].includes(app.status) ||
      JSON.stringify(await repository.getMigrationLedger(app.id)) !== JSON.stringify(context.previousLedger)
    )
      throw recovery();
    const firstPreparation =
      state.phase === 'target-ready' &&
      state.migrationPreparation?.phase === 'intent' &&
      !(await MigrationJournal.operationExists(journalRoot, state.requestId));
    const preparation = {
      stage: input.stage,
      appUrn: input.appUrn,
      service,
      docker: input.docker,
      journalRoot,
      localDirectory: input.moduleRef.get(AppFilesManager, { strict: false }).getAppPaths(input.appUrn).appDataDir,
      socketPath: process.env.ORBIS_HOST_SOCKET ?? '',
      archive: input.moduleRef.get(ArchiveService, { strict: false }),
    };
    migrations = firstPreparation
      ? await AppUpdateMigrations.prepare({ ...preparation, architecture: config.get('architecture') })
      : await AppUpdateMigrations.resume(preparation);
    let saved = await migrations.journal.read();
    if (state.rollback || ['capturing', 'recovery-required', 'restoring', 'restored'].includes(saved.phase)) {
      if (
        saved.targetWritesPossible ||
        saved.commitAttempted ||
        !['target-ready', 'switching', 'prepared', 'rolling-back', 'rolled-back'].includes(state.phase)
      )
        throw recovery();
      await input.report('recovering');
      const updateStatus = await rollbackMigratingAppUpdate({
        stage: input.stage,
        migrations,
        repository,
        docker: input.docker,
        appUrn: input.appUrn,
      });
      return {
        success: false,
        statePreserved: true,
        updateStatus,
        message: 'The interrupted update was rolled back. The previous app deployment was restored.',
      };
    }

    if (!['allocated', 'ready', 'running', 'migrations-complete', 'activation-attempted'].includes(saved.phase) || saved.commitAttempted)
      throw recovery();
    if (
      (['allocated', 'ready', 'running'].includes(saved.phase) && state.phase !== 'target-ready') ||
      (saved.phase === 'migrations-complete' && !['target-ready', 'switching', 'prepared'].includes(state.phase)) ||
      (saved.phase === 'activation-attempted' && !['prepared', 'activation-attempted'].includes(state.phase))
    )
      throw recovery();
    plan = await service.prepareResumedAppUpdate(input.appUrn, input.stage, input.docker);
    if (!(await plan.isCurrent())) throw recovery();
    if (saved.phase === 'allocated') {
      await input.report('stopping');
      await stopOriginalUpdateRuntime(input.docker, input.appUrn, context);
      await input.report('backing_up');
      if (input.performBackup) await captureStoppedAppBackup(input.moduleRef, input.appUrn);
      await migrations.capture();
      saved = await migrations.journal.read();
    }
    if (['ready', 'running'].includes(saved.phase)) {
      originalStopped(await currentContainers(input.docker, input.appUrn), context);
      await input.report('migrating');
      await migrations.run();
      saved = await migrations.journal.read();
    }
    const phase = (await input.stage.read()).phase;
    if (['target-ready', 'switching'].includes(phase)) {
      if (saved.phase !== 'migrations-complete') throw recovery();
      await input.report('publishing');
      await input.stage.publishTarget();
    }
    const prepared = (await input.stage.read()).phase;
    if (prepared === 'prepared') {
      originalStopped(await currentContainers(input.docker, input.appUrn), context);
      if (context.updateStatus === 'running') {
        // If only the migration marker persisted, the metadata marker proves no target start was issued yet.
        if (saved.phase === 'migrations-complete') await migrations.activationAttempted();
        else if (saved.phase !== 'activation-attempted') throw recovery();
        await migrations.verifyStorage();
        await input.stage.activationAttempted();
        await input.report('starting');
        await plan.activate();
      } else if (saved.phase !== 'migrations-complete') throw recovery();
    } else if (prepared !== 'activation-attempted' || saved.phase !== 'activation-attempted' || context.updateStatus !== 'running') throw recovery();
    await input.report('verifying');
    await verifyAppUpdateRuntime(input.docker, input.appUrn, context, input.stage.id, state.pulledImages.imageIds);
    if (!(await plan.isCurrent())) throw recovery();
    await input.report('committing');
    await migrations.beginCommit();
    const selected = migrations;
    await input.stage.commit(() => selected.commit(repository, context.updateStatus, context.updateStatus === 'running' ? false : undefined));
    return { success: true, message: 'The saved app migration update completed.', updateStatus: context.updateStatus };
  } finally {
    await plan?.release().catch(() => undefined);
    await migrations?.close().catch(() => undefined);
    await journal?.close().catch(() => undefined);
  }
}
