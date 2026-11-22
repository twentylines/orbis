import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@/core/database/database.module';
import { app, appMigration, appMigrationCommit } from '@/core/database/drizzle/schema';
import { migrationFailure, migrationOperationSchema, type MigrationJournalState } from '../backups/app-migration-journal';

/** Rollback may settle only the old status. It never changes version, migration history or forward commit receipts. */
export function migrationRollbackBinding(state: Readonly<MigrationJournalState>) {
  const operation = migrationOperationSchema.assert(state.operation);
  const untouched = ['allocated', 'capturing', 'ready'].includes(state.phase) && state.runners.length === 0 && state.restores.length === 0;
  const restored =
    state.phase === 'restored' &&
    state.restores.at(-1)?.phase === 'committed' &&
    state.checkpoint !== null &&
    /^[a-f0-9]{64}$/.test(state.checkpoint.sha256);
  if (
    !operation.previousLedger.baselined ||
    state.targetWritesPossible !== false ||
    state.commitAttempted !== false ||
    state.commitReceiptSha256 !== null ||
    (!untouched && !restored)
  )
    throw migrationFailure();
  return operation;
}

async function inspect(transaction: Database, state: Readonly<MigrationJournalState>, status: 'running' | 'stopped') {
  if (!['running', 'stopped'].includes(status)) throw migrationFailure();
  const operation = migrationRollbackBinding(state);
  const [current] = await transaction.select().from(app).where(eq(app.id, operation.appId)).for('update');
  const [receipt] = await transaction.select().from(appMigrationCommit).where(eq(appMigrationCommit.requestId, operation.requestId));
  const [name, store] = operation.appUrn.split(':');
  if (
    !current ||
    receipt ||
    current.id !== operation.appId ||
    current.createdAt !== operation.createdAt ||
    current.appName !== name ||
    current.appStoreSlug !== store ||
    current.version !== operation.fromVersion ||
    current.migrationsBaselined !== operation.previousLedger.baselined ||
    !['updating', status].includes(current.status)
  )
    throw migrationFailure();
  const rows = await transaction
    .select({ migrationId: appMigration.migrationId })
    .from(appMigration)
    .where(eq(appMigration.appId, operation.appId))
    .orderBy(asc(appMigration.migrationId));
  if (JSON.stringify(rows.map(({ migrationId }) => migrationId).sort()) !== JSON.stringify([...operation.previousLedger.migrationIds].sort()))
    throw migrationFailure();
  return { operation, current };
}

export async function settleMigrationRollback(
  database: Database,
  raw: Readonly<MigrationJournalState>,
  status: 'running' | 'stopped',
  pendingRestart?: true,
) {
  const state = structuredClone(raw);
  try {
    if (pendingRestart !== undefined && pendingRestart !== true) throw migrationFailure();
    migrationRollbackBinding(state);
    return await database.transaction(
      async (transaction) => {
        const { operation, current } = await inspect(transaction as unknown as Database, state, status);
        if (current.status !== status || (pendingRestart && !current.pendingRestart)) {
          const rows = await transaction
            .update(app)
            .set({ status, updatedAt: Math.floor(Date.now() / 1000), ...(pendingRestart ? { pendingRestart: true } : {}) })
            .where(
              and(
                eq(app.id, operation.appId),
                eq(app.createdAt, operation.createdAt),
                eq(app.version, operation.fromVersion),
                eq(app.status, current.status),
              ),
            )
            .returning({ id: app.id });
          if (rows.length !== 1) throw migrationFailure();
        }
        return true;
      },
      { isolationLevel: 'serializable' },
    );
  } catch {
    throw migrationFailure();
  }
}

export async function readMigrationRollback(database: Database, raw: Readonly<MigrationJournalState>, status: 'running' | 'stopped') {
  const state = structuredClone(raw);
  try {
    migrationRollbackBinding(state);
    return await database.transaction(
      async (transaction) => (await inspect(transaction as unknown as Database, state, status)).current.status === status,
      { isolationLevel: 'serializable' },
    );
  } catch {
    throw migrationFailure();
  }
}
