import type Dockerode from 'dockerode';
import type { AppUrn } from '@runtipi/common/types';
import type { AppsRepository } from '../../apps/apps.repository';
import type { AppUpdateStage } from '../../docker/app-update-stage';
import type { AppUpdateMigrations } from '../../docker/app-update-migrations';
import { restoreOriginalRollbackRuntime, verifyOriginalRollbackRuntime } from './app-update-runtime';

const failure = () => new Error('The previous app deployment still needs verified recovery. Its saved context was kept.');
export async function rollbackMigratingAppUpdate(input: {
  stage: AppUpdateStage;
  migrations: AppUpdateMigrations;
  repository: AppsRepository;
  docker: Dockerode;
  appUrn: AppUrn;
}) {
  await input.stage.retainRollback(input.migrations.journal);
  await input.migrations.recoverBeforeActivation();
  await input.stage.restoreMetadata();
  const state = await input.stage.read();
  const context = state.context;
  if (!context || !state.rollback) throw failure();
  await input.migrations.verifyRollbackWriters();
  if (state.rollback.phase === 'retained') {
    await restoreOriginalRollbackRuntime(input.docker, input.appUrn, input.stage);
    await input.migrations.verifyRollbackWriters();
    await input.repository.settleMigrationRollback(await input.migrations.journal.read(), context.updateStatus);
  }
  await verifyOriginalRollbackRuntime(input.docker, input.appUrn, context);
  await input.migrations.verifyRollbackWriters();
  await input.stage.finishRollback(input.migrations.journal, input.repository);
  return context.updateStatus;
}
