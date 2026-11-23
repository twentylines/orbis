import { appUpdateSettingsSchema, matchesAppUpdateSettings } from './app-update-settings';
import { type } from 'arktype';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@/core/database/database.module';
import { app, appMigration, appMigrationCommit } from '@/core/database/drizzle/schema';
import { arkAppUrn } from '@runtipi/common/types';
import { migrationHash } from '../backups/app-migration-journal';
import { AppUpdateStage } from '../docker/app-update-stage';
import { appMigrationLedgerSchema } from './app-migration-ledger';

const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const resultSchema = type({
  schema: "'orbis.app-update-result.v1'",
  appUrn: arkAppUrn,
  requestId: uuid,
  stageId: uuid,
  appId: 'number.integer > 0 & number <= 2147483647',
  appCreatedAt: '0 <= number.integer <= 2147483647',
  fromVersion: '0 <= number.integer <= 2147483647',
  version: '0 <= number.integer <= 2147483647',
  status: "'running' | 'stopped'",
  pendingRestart: type('boolean').or('null'),
  requestInputSha256: hash,
  'settings?': appUpdateSettingsSchema,
  proofSha256: hash,
  ledger: appMigrationLedgerSchema,
  ledgerSha256: hash,
  operationSha256: hash,
}).onUndeclaredKey('reject');
export type OrdinaryUpdateResult = typeof resultSchema.infer;
export const ordinaryUpdateFailure = () => new Error('This app update needs recovery. Its saved files and new app writes were kept.');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function verifyOrdinaryUpdateResult(raw: unknown): OrdinaryUpdateResult {
  const result = resultSchema.assert(raw);
  const { operationSha256, ...body } = result;
  if (
    !same(result.ledger.migrationIds, [...result.ledger.migrationIds].sort()) ||
    result.ledgerSha256 !== migrationHash(result.ledger) ||
    (result.status === 'stopped') !== (result.pendingRestart === null) ||
    (result.settings !== undefined && result.settings.sourceSha256 !== result.requestInputSha256) ||
    operationSha256 !== migrationHash(body)
  )
    throw ordinaryUpdateFailure();
  return structuredClone(result);
}

/** A durable ordinary-update intent is distinct from migration execution and fresh-install receipts. */
export async function ordinaryUpdateResultBinding(stage: AppUpdateStage): Promise<OrdinaryUpdateResult> {
  if (!(stage instanceof AppUpdateStage)) throw ordinaryUpdateFailure();
  const state = await stage.read();
  const context = state.context;
  if (
    !context ||
    context.purpose !== undefined ||
    !state.ordinaryCommit ||
    state.freshInstall ||
    state.rollback ||
    state.migrationPreparation ||
    !state.prepared ||
    !state.pulledImages ||
    context.targetMigrationIds.some((id) => !context.previousLedger.migrationIds.includes(id)) ||
    (!context.previousLedger.baselined && (context.previousLedger.migrationIds.length || context.targetMigrationIds.length)) ||
    !['prepared', 'activation-attempted', 'committing', 'commit-verified'].includes(state.phase) ||
    (state.phase === 'prepared' && context.updateStatus !== 'stopped')
  )
    throw ordinaryUpdateFailure();
  const ledger = { ...context.previousLedger, migrationIds: [...context.previousLedger.migrationIds].sort() };
  const body = {
    schema: 'orbis.app-update-result.v1' as const,
    appUrn: arkAppUrn.assert(state.appUrn),
    requestId: state.requestId,
    stageId: state.id,
    appId: context.appId,
    appCreatedAt: context.appCreatedAt,
    fromVersion: context.fromVersion,
    version: context.toVersion,
    status: context.updateStatus,
    pendingRestart: state.ordinaryCommit.pendingRestart,
    requestInputSha256: context.requestInputSha256,
    ...(context.settings ? { settings: context.settings } : {}),
    proofSha256: migrationHash({
      context,
      baseline: state.baseline,
      prepared: state.prepared,
      images: state.pulledImages,
      retainedPinsSha256: state.retainedPinsSha256,
    }),
    ledger,
    ledgerSha256: migrationHash(ledger),
  };
  return verifyOrdinaryUpdateResult({ ...body, operationSha256: migrationHash(body) });
}

async function readReceipt(database: Database, result: OrdinaryUpdateResult) {
  const [receipt] = await database.select().from(appMigrationCommit).where(eq(appMigrationCommit.requestId, result.requestId));
  if (!receipt) return false;
  if (
    receipt.appId !== result.appId ||
    receipt.stageId !== result.stageId ||
    receipt.operationSha256 !== result.operationSha256 ||
    receipt.ledgerSha256 !== result.ledgerSha256 ||
    receipt.version !== result.version ||
    !Number.isSafeInteger(receipt.committedAt) ||
    receipt.committedAt < 0 ||
    receipt.committedAt > 2147483647
  )
    throw ordinaryUpdateFailure();
  return true;
}

async function lockedApp(database: Database, result: OrdinaryUpdateResult, committed: boolean, locked?: typeof app.$inferSelect) {
  const current = locked ?? (await database.select().from(app).where(eq(app.id, result.appId)).for('update'))[0];
  const [name, store] = result.appUrn.split(':');
  if (
    !current ||
    current.createdAt !== result.appCreatedAt ||
    current.appName !== name ||
    current.appStoreSlug !== store ||
    current.version !== (committed ? result.version : result.fromVersion) ||
    current.status !== (committed ? result.status : 'updating') ||
    current.migrationsBaselined !== result.ledger.baselined ||
    (result.settings !== undefined && !matchesAppUpdateSettings(current, result.settings, committed)) ||
    (committed && result.pendingRestart !== null && current.pendingRestart !== result.pendingRestart)
  )
    throw ordinaryUpdateFailure();
  const rows = await database
    .select({ migrationId: appMigration.migrationId })
    .from(appMigration)
    .where(eq(appMigration.appId, result.appId))
    .orderBy(asc(appMigration.migrationId));
  if (
    !same(
      rows.map(({ migrationId }) => migrationId),
      result.ledger.migrationIds,
    )
  )
    throw ordinaryUpdateFailure();
  return current;
}

/** An uncertain write is acknowledged read-only from its exact receipt AND current row/complete history. */
export async function readCurrentOrdinaryUpdateCommit(database: Database, raw: OrdinaryUpdateResult) {
  const result = verifyOrdinaryUpdateResult(raw);
  return database.transaction(
    async (transaction) => {
      const db = transaction as unknown as Database;
      if (!(await readReceipt(db, result))) return false;
      await lockedApp(db, result, true);
      return true;
    },
    { isolationLevel: 'serializable' },
  );
}

/** Final version, status and exact request receipt commit together; no automatic SQL retry. */
export async function commitOrdinaryAppUpdate(database: Database, stage: AppUpdateStage, raw: OrdinaryUpdateResult) {
  const result = verifyOrdinaryUpdateResult(raw);
  if ((await stage.read()).phase !== 'committing' || !same(await ordinaryUpdateResultBinding(stage), result)) throw ordinaryUpdateFailure();
  return database.transaction(
    async (transaction) => {
      const db = transaction as unknown as Database;
      if (await readReceipt(db, result)) {
        await lockedApp(db, result, true);
        return true;
      }
      // Lock before rechecking the unique request receipt. A competing writer can never silently change the saved app row.
      const [current] = await transaction.select().from(app).where(eq(app.id, result.appId)).for('update');
      if (await readReceipt(db, result)) {
        await lockedApp(db, result, true, current);
        return true;
      }
      if (!current) throw ordinaryUpdateFailure();
      await lockedApp(db, result, false, current);
      const now = Math.floor(Date.now() / 1000);
      const updated = await transaction
        .update(app)
        .set({
          ...result.settings?.values,
          version: result.version,
          status: result.status,
          updatedAt: now,
          ...(result.pendingRestart === null ? {} : { pendingRestart: result.pendingRestart }),
        })
        .where(and(eq(app.id, result.appId), eq(app.createdAt, result.appCreatedAt), eq(app.version, result.fromVersion), eq(app.status, 'updating')))
        .returning({ id: app.id });
      if (updated.length !== 1) throw ordinaryUpdateFailure();
      await transaction.insert(appMigrationCommit).values({
        requestId: result.requestId,
        appId: result.appId,
        stageId: result.stageId,
        operationSha256: result.operationSha256,
        ledgerSha256: result.ledgerSha256,
        version: result.version,
        committedAt: now,
      });
      return true;
    },
    { isolationLevel: 'serializable' },
  );
}
