import { type } from 'arktype';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@/core/database/database.module';
import { app, appMigration, appMigrationCommit } from '@/core/database/drizzle/schema';
import type { MigrationJournalState } from '../backups/app-migration-journal';
import { migrationFailure, migrationHash, migrationOperationSchema } from '../backups/app-migration-journal';
import { appMigrationLedgerSchema } from './app-migration-ledger';

const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const receiptSchema = type({
  requestId: uuid,
  appId: 'number.integer > 0 & number <= 2147483647',
  stageId: uuid,
  operationSha256: hash,
  ledgerSha256: hash,
  version: '0 <= number.integer <= 2147483647',
  committedAt: '0 <= number.integer <= 2147483647',
}).onUndeclaredKey('reject');
export type AppMigrationCommitReceipt = typeof receiptSchema.infer;

/** Only a persisted commit intent may reach the transaction. The command must verify target health first. */
export function appMigrationCommitBinding(raw: Readonly<MigrationJournalState>) {
  const state = structuredClone(raw);
  const operation = migrationOperationSchema.assert(state.operation);
  if (
    !operation.previousLedger.baselined ||
    !state.commitAttempted ||
    !['commit-intent', 'committed', 'recovery-required'].includes(state.phase) ||
    !state.checkpoint ||
    !hash.allows(state.checkpoint.sha256) ||
    !hash.allows(state.storageSha256) ||
    state.restores.length ||
    state.runners.length !== operation.images.length ||
    state.runners.some(
      (row, index) =>
        row.migrationId !== operation.images[index]?.migrationId ||
        row.phase !== 'terminal' ||
        row.exitCode !== 0 ||
        !hash.allows(row.containerId) ||
        !hash.allows(row.terminalSha256) ||
        !hash.allows(row.specSha256),
    )
  )
    throw migrationFailure();
  const ledger = appMigrationLedgerSchema.assert({
    baselined: true,
    migrationIds: [...operation.previousLedger.migrationIds, ...operation.images.map(({ migrationId }) => migrationId)].sort(),
  });
  const binding = {
    requestId: operation.requestId,
    appId: operation.appId,
    stageId: operation.stageId,
    operationSha256: migrationHash({
      operation,
      storageSha256: state.storageSha256,
      checkpoint: state.checkpoint,
      sourceController: state.sourceController,
      runners: state.runners,
      targetWritesPossible: state.targetWritesPossible,
    }),
    ledgerSha256: migrationHash(ledger),
    version: operation.toVersion,
  };
  return { operation, ledger, binding };
}

export function verifyAppMigrationCommitReceipt(raw: unknown, state: Readonly<MigrationJournalState>) {
  const receipt = receiptSchema.assert(raw);
  const { binding } = appMigrationCommitBinding(state);
  if (Object.entries(binding).some(([key, value]) => Reflect.get(receipt, key) !== value)) throw migrationFailure();
  const sha256 = migrationHash({ ...binding, committedAt: receipt.committedAt });
  if (state.commitReceiptSha256 !== null && state.commitReceiptSha256 !== sha256) throw migrationFailure();
  return { receipt: structuredClone(receipt), sha256 };
}

/** An absent receipt is never permission to restore or rerun an uncertain operation. */
export async function readAppMigrationCommit(database: Database, state: Readonly<MigrationJournalState>) {
  try {
    const { binding } = appMigrationCommitBinding(state);
    const [receipt] = await database.select().from(appMigrationCommit).where(eq(appMigrationCommit.requestId, binding.requestId));
    return receipt ? verifyAppMigrationCommitReceipt(receipt, state) : undefined;
  } catch {
    throw migrationFailure();
  }
}

/** Version, complete ledger and request-bound receipt commit in the same serializable transaction. */
export async function commitAppMigration(
  database: Database,
  raw: Readonly<MigrationJournalState>,
  status: 'running' | 'stopped',
  pendingRestart?: boolean,
) {
  const state = structuredClone(raw);
  try {
    if (
      !['running', 'stopped'].includes(status) ||
      (pendingRestart !== undefined && typeof pendingRestart !== 'boolean') ||
      (status === 'running') !== state.targetWritesPossible
    )
      throw migrationFailure();
    const { operation, ledger, binding } = appMigrationCommitBinding(state);
    return await database.transaction(
      async (transaction) => {
        const prior = await transaction.select().from(appMigrationCommit).where(eq(appMigrationCommit.requestId, binding.requestId));
        if (prior[0]) return { ...verifyAppMigrationCommitReceipt(prior[0], state), replayed: true };
        // A confirmed private acknowledgement cannot be used to recreate a missing SQL receipt after a database rollback.
        if (state.phase === 'committed' || state.commitReceiptSha256 !== null) throw migrationFailure();
        const [current] = await transaction.select().from(app).where(eq(app.id, operation.appId)).for('update');
        // A concurrent first transaction may have committed while this one waited for the app lock.
        const replay = await transaction.select().from(appMigrationCommit).where(eq(appMigrationCommit.requestId, binding.requestId));
        if (replay[0]) return { ...verifyAppMigrationCommitReceipt(replay[0], state), replayed: true };
        const [name, store] = operation.appUrn.split(':');
        if (
          !current ||
          current.createdAt !== operation.createdAt ||
          current.appName !== name ||
          current.appStoreSlug !== store ||
          current.version !== operation.fromVersion ||
          current.status !== 'updating' ||
          current.migrationsBaselined !== operation.previousLedger.baselined
        )
          throw migrationFailure();
        const previous = await transaction
          .select({ migrationId: appMigration.migrationId })
          .from(appMigration)
          .where(eq(appMigration.appId, operation.appId))
          .orderBy(asc(appMigration.migrationId));
        if (
          JSON.stringify(previous.map(({ migrationId }) => migrationId).sort()) !== JSON.stringify([...operation.previousLedger.migrationIds].sort())
        )
          throw migrationFailure();
        const now = Math.floor(Date.now() / 1000);
        const updated = await transaction
          .update(app)
          .set({
            version: operation.toVersion,
            status,
            ...(pendingRestart === undefined ? {} : { pendingRestart }),
            migrationsBaselined: true,
            updatedAt: now,
          })
          .where(
            and(
              eq(app.id, operation.appId),
              eq(app.createdAt, operation.createdAt),
              eq(app.version, operation.fromVersion),
              eq(app.status, 'updating'),
            ),
          )
          .returning({ id: app.id });
        if (updated.length !== 1) throw migrationFailure();
        await transaction.delete(appMigration).where(eq(appMigration.appId, operation.appId));
        if (ledger.migrationIds.length)
          await transaction.insert(appMigration).values(ledger.migrationIds.map((migrationId) => ({ appId: operation.appId, migrationId })));
        const rows = await transaction
          .insert(appMigrationCommit)
          .values({ ...binding, committedAt: now })
          .returning();
        if (rows.length !== 1) throw migrationFailure();
        return { ...verifyAppMigrationCommitReceipt(rows[0], state), replayed: false };
      },
      { isolationLevel: 'serializable' },
    );
  } catch {
    throw migrationFailure();
  }
}
