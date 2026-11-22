import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@/core/database/database.module';
import { app, appMigration, appMigrationCommit } from '@/core/database/drizzle/schema';
import { migrationHash } from '../backups/app-migration-journal';
import type { ExistingAppBaseline } from '../docker/app-existing-storage';
import { verifyExistingAppBaseline } from '../docker/app-existing-storage';
import { AppUpdateStage } from '../docker/app-update-stage';

import { existingBaselineBindingSchema, existingBaselineFailure, type ExistingBaselineBinding } from './app-existing-baseline-schema';

function receiptId(kind: string, binding: ExistingBaselineBinding) {
  const digest = createHash('sha256').update(`orbis.existing-baseline/${kind}/${binding.requestId}/${binding.stageId}`).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
export function existingBaselineReceiptBinding(raw: ExistingBaselineBinding) {
  const binding = existingBaselineBindingSchema.assert(raw);
  return {
    requestId: receiptId('request', binding),
    appId: binding.appId,
    stageId: receiptId('stage', binding),
    operationSha256: migrationHash(binding),
    ledgerSha256: migrationHash({ baselined: true, migrationIds: binding.migrationIds }),
    version: binding.version,
  };
}
async function receipt(database: Database, raw: ExistingBaselineBinding) {
  const binding = existingBaselineReceiptBinding(raw);
  const [row] = await database.select().from(appMigrationCommit).where(eq(appMigrationCommit.requestId, binding.requestId));
  if (!row) return false;
  if (
    Object.entries(binding).some(([key, value]) => Reflect.get(row, key) !== value) ||
    !Number.isSafeInteger(row.committedAt) ||
    row.committedAt < 0
  )
    throw existingBaselineFailure();
  return true;
}
async function current(database: Database, binding: ExistingBaselineBinding) {
  const [row] = await database.select().from(app).where(eq(app.id, binding.appId)).for('update');
  const [name, store] = binding.appUrn.split(':');
  if (
    !row ||
    row.createdAt !== binding.appCreatedAt ||
    row.appName !== name ||
    row.appStoreSlug !== store ||
    row.version !== binding.version ||
    row.status !== 'updating'
  )
    throw existingBaselineFailure();
  const rows = await database
    .select({ migrationId: appMigration.migrationId })
    .from(appMigration)
    .where(eq(appMigration.appId, binding.appId))
    .orderBy(asc(appMigration.migrationId));
  return { row, ids: rows.map(({ migrationId }) => migrationId) };
}
export async function readExistingAppBaseline(database: Database, raw: ExistingBaselineBinding) {
  const binding = existingBaselineBindingSchema.assert(raw);
  return database.transaction(
    async (transaction) => {
      const db = transaction as unknown as Database;
      if (!(await receipt(db, binding))) return false;
      const { row, ids } = await current(db, binding);
      if (!row.migrationsBaselined || JSON.stringify(ids) !== JSON.stringify(binding.migrationIds)) throw existingBaselineFailure();
      return true;
    },
    { isolationLevel: 'serializable' },
  );
}

/** Existing-version cut-over: marks IDs already shipped in the deployed package as baseline, never as scripts executed here. */
export async function commitExistingAppBaseline(database: Database, stage: AppUpdateStage, proof: ExistingAppBaseline) {
  if (!(stage instanceof AppUpdateStage)) throw existingBaselineFailure();
  const binding = await verifyExistingAppBaseline(proof, stage);
  const state = await stage.read();
  if (state.existingBaseline?.phase !== 'intent' || JSON.stringify(state.existingBaseline.binding) !== JSON.stringify(binding))
    throw existingBaselineFailure();
  return database.transaction(
    async (transaction) => {
      const db = transaction as unknown as Database;
      if (await receipt(db, binding)) {
        const { row, ids } = await current(db, binding);
        if (!row.migrationsBaselined || JSON.stringify(ids) !== JSON.stringify(binding.migrationIds)) throw existingBaselineFailure();
        return true;
      }
      const { row, ids } = await current(db, binding);
      if (row.migrationsBaselined || ids.length) throw existingBaselineFailure();
      await verifyExistingAppBaseline(proof, stage);
      const now = Math.floor(Date.now() / 1000);
      const updated = await transaction
        .update(app)
        .set({ migrationsBaselined: true, updatedAt: now })
        .where(
          and(
            eq(app.id, binding.appId),
            eq(app.createdAt, binding.appCreatedAt),
            eq(app.version, binding.version),
            eq(app.status, 'updating'),
            eq(app.migrationsBaselined, false),
          ),
        )
        .returning({ id: app.id });
      if (updated.length !== 1) throw existingBaselineFailure();
      if (binding.migrationIds.length)
        await transaction.insert(appMigration).values(binding.migrationIds.map((migrationId) => ({ appId: binding.appId, migrationId })));
      await transaction.insert(appMigrationCommit).values({ ...existingBaselineReceiptBinding(binding), committedAt: now });
      return true;
    },
    { isolationLevel: 'serializable' },
  );
}
