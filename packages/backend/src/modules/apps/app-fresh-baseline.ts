import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@/core/database/database.module';
import { app, appMigration } from '@/core/database/drizzle/schema';
import { AppUpdateStage } from '../docker/app-update-stage';

const failure = () => new Error('The fresh install migration baseline could not be verified. Its saved operation was kept.');
async function binding(stage: AppUpdateStage) {
  if (!(stage instanceof AppUpdateStage)) throw failure();
  const state = await stage.verifyFreshInstall();
  const context = state.context;
  if (
    context?.purpose !== 'fresh-install' ||
    context.fromVersion !== context.toVersion ||
    context.previousLedger.baselined ||
    context.previousLedger.migrationIds.length ||
    context.originalContainers.length ||
    !state.freshInstall ||
    !['baseline-intent', 'baselined'].includes(state.freshInstall.phase) ||
    !state.freshInstall.containers.length ||
    !['prepared', 'activation-attempted', 'committing', 'commit-verified'].includes(state.phase)
  )
    throw failure();
  return { state, context };
}
async function inspect(transaction: Database, stage: AppUpdateStage) {
  const { context, state } = await binding(stage);
  const [current] = await transaction.select().from(app).where(eq(app.id, context.appId)).for('update');
  const [name, store] = state.appUrn.split(':');
  if (
    !current ||
    current.id !== context.appId ||
    current.createdAt !== context.appCreatedAt ||
    current.appName !== name ||
    current.appStoreSlug !== store ||
    current.version !== context.toVersion ||
    !['installing', 'stopped'].includes(current.status)
  )
    throw failure();
  const rows = await transaction
    .select({ migrationId: appMigration.migrationId })
    .from(appMigration)
    .where(eq(appMigration.appId, context.appId))
    .orderBy(asc(appMigration.migrationId));
  return { current, context, ids: rows.map(({ migrationId }) => migrationId) };
}
export async function commitFreshInstallBaseline(database: Database, stage: AppUpdateStage) {
  try {
    const initial = await binding(stage);
    if (initial.state.freshInstall?.phase !== 'baseline-intent') throw failure();
    return await database.transaction(
      async (transaction) => {
        const { current, context, ids } = await inspect(transaction as unknown as Database, stage);
        if (current.migrationsBaselined || ids.length) throw failure();
        const updated = await transaction
          .update(app)
          .set({ migrationsBaselined: true, updatedAt: Math.floor(Date.now() / 1000) })
          .where(
            and(
              eq(app.id, context.appId),
              eq(app.createdAt, context.appCreatedAt),
              eq(app.version, context.toVersion),
              eq(app.status, current.status),
              eq(app.migrationsBaselined, false),
            ),
          )
          .returning({ id: app.id });
        if (updated.length !== 1) throw failure();
        if (context.targetMigrationIds.length)
          await transaction.insert(appMigration).values(context.targetMigrationIds.map((migrationId) => ({ appId: context.appId, migrationId })));
        return true;
      },
      { isolationLevel: 'serializable' },
    );
  } catch {
    throw failure();
  }
}
export async function readFreshInstallBaseline(database: Database, stage: AppUpdateStage) {
  try {
    await binding(stage);
    return await database.transaction(
      async (transaction) => {
        const { current, context, ids } = await inspect(transaction as unknown as Database, stage);
        return current.migrationsBaselined && JSON.stringify(ids) === JSON.stringify([...context.targetMigrationIds].sort());
      },
      { isolationLevel: 'serializable' },
    );
  } catch {
    throw failure();
  }
}
