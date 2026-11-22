import { type } from 'arktype';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@/core/database/database.module';
import { app, appMigration, appMigrationCommit } from '@/core/database/drizzle/schema';
import { arkAppUrn } from '@runtipi/common/types';
import { migrationHash } from '../backups/app-migration-journal';
import { AppUpdateStage } from '../docker/app-update-stage';

const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
export const freshInstallResultSchema = type({
  schema: "'orbis.fresh-install-result.v1'",
  appUrn: arkAppUrn,
  requestId: uuid,
  stageId: uuid,
  appId: 'number.integer > 0 & number <= 2147483647',
  appCreatedAt: '0 <= number.integer <= 2147483647',
  version: '0 <= number.integer <= 2147483647',
  status: "'running' | 'stopped'",
  requestInputSha256: hash,
  proofSha256: hash,
  migrationIds: type('string')
    .narrow((value) => /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value))
    .array()
    .atMostLength(300),
  ledgerSha256: hash,
  operationSha256: hash,
}).onUndeclaredKey('reject');
export type FreshInstallResult = typeof freshInstallResultSchema.infer;
export const freshInstallFailure = () => new Error('The saved app installation needs recovery. Its files and new app data were kept.');

export function verifyFreshInstallResult(raw: unknown): FreshInstallResult {
  const record = freshInstallResultSchema.assert(raw);
  const { operationSha256, ...body } = record;
  if (
    new Set(record.migrationIds).size !== record.migrationIds.length ||
    JSON.stringify(record.migrationIds) !== JSON.stringify([...record.migrationIds].sort()) ||
    record.ledgerSha256 !== migrationHash({ baselined: true, migrationIds: record.migrationIds }) ||
    operationSha256 !== migrationHash(body)
  )
    throw freshInstallFailure();
  return structuredClone(record);
}

/** Domain-separated from migration execution receipts. Only a real, prepared fresh stage can create its binding. */
export async function freshInstallResultBinding(stage: AppUpdateStage): Promise<FreshInstallResult> {
  if (!(stage instanceof AppUpdateStage)) throw freshInstallFailure();
  const state = await stage.verifyFreshInstall();
  const context = state.context;
  if (
    context?.purpose !== 'fresh-install' ||
    context.fromVersion !== context.toVersion ||
    context.previousLedger.baselined ||
    context.previousLedger.migrationIds.length ||
    context.originalContainers.length ||
    state.freshInstall?.phase !== 'baselined' ||
    !state.freshInstall.imagePinsSha256 ||
    !state.prepared ||
    !state.pulledImages ||
    !['prepared', 'activation-attempted', 'committing', 'commit-verified'].includes(state.phase) ||
    (state.phase === 'prepared' && context.updateStatus !== 'stopped')
  )
    throw freshInstallFailure();
  const migrationIds = [...context.targetMigrationIds].sort();
  const body = {
    schema: 'orbis.fresh-install-result.v1' as const,
    appUrn: arkAppUrn.assert(state.appUrn),
    requestId: state.requestId,
    stageId: state.id,
    appId: context.appId,
    appCreatedAt: context.appCreatedAt,
    version: context.toVersion,
    status: context.updateStatus,
    requestInputSha256: context.requestInputSha256,
    proofSha256: migrationHash({ context, prepared: state.prepared, images: state.pulledImages, storage: state.freshInstall }),
    migrationIds,
    ledgerSha256: migrationHash({ baselined: true, migrationIds }),
  };
  return verifyFreshInstallResult({ ...body, operationSha256: migrationHash(body) });
}

/** Read-only acknowledgement is valid after the private stage is retired too. It never authorizes starting an app. */
export async function readFreshInstallCommit(database: Database, raw: FreshInstallResult) {
  const result = verifyFreshInstallResult(raw);
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
    throw freshInstallFailure();
  return true;
}

/** Releasing an unfinished stage also requires the current row and complete ledger, not just a historical receipt. */
export async function readCurrentFreshInstallCommit(database: Database, raw: FreshInstallResult) {
  const result = verifyFreshInstallResult(raw);
  return database.transaction(
    async (transaction) => {
      if (!(await readFreshInstallCommit(transaction as unknown as Database, result))) return false;
      const [current] = await transaction.select().from(app).where(eq(app.id, result.appId)).for('update');
      const [name, store] = result.appUrn.split(':');
      if (
        !current ||
        current.createdAt !== result.appCreatedAt ||
        current.appName !== name ||
        current.appStoreSlug !== store ||
        current.version !== result.version ||
        !current.migrationsBaselined ||
        !['running', 'stopped'].includes(current.status)
      )
        throw freshInstallFailure();
      const rows = await transaction
        .select({ migrationId: appMigration.migrationId })
        .from(appMigration)
        .where(eq(appMigration.appId, result.appId))
        .orderBy(asc(appMigration.migrationId));
      if (JSON.stringify(rows.map(({ migrationId }) => migrationId)) !== JSON.stringify(result.migrationIds)) throw freshInstallFailure();
      return true;
    },
    { isolationLevel: 'serializable' },
  );
}

/** Final status and its exact request receipt become durable together, after verified first-start health. */
export async function commitFreshInstall(database: Database, stage: AppUpdateStage, raw: FreshInstallResult) {
  const result = verifyFreshInstallResult(raw);
  const currentBinding = await freshInstallResultBinding(stage);
  if ((await stage.read()).phase !== 'committing' || JSON.stringify(currentBinding) !== JSON.stringify(result)) throw freshInstallFailure();
  return database.transaction(
    async (transaction) => {
      const db = transaction as unknown as Database;
      if (await readFreshInstallCommit(db, result)) return true;
      const [current] = await transaction.select().from(app).where(eq(app.id, result.appId)).for('update');
      if (await readFreshInstallCommit(db, result)) return true;
      const [name, store] = result.appUrn.split(':');
      if (
        !current ||
        current.createdAt !== result.appCreatedAt ||
        current.appName !== name ||
        current.appStoreSlug !== store ||
        current.version !== result.version ||
        !['installing', 'stopped'].includes(current.status) ||
        !current.migrationsBaselined
      )
        throw freshInstallFailure();
      const rows = await transaction
        .select({ migrationId: appMigration.migrationId })
        .from(appMigration)
        .where(eq(appMigration.appId, result.appId))
        .orderBy(asc(appMigration.migrationId));
      if (JSON.stringify(rows.map(({ migrationId }) => migrationId)) !== JSON.stringify(result.migrationIds)) throw freshInstallFailure();
      const now = Math.floor(Date.now() / 1000);
      const updated = await transaction
        .update(app)
        .set({ status: result.status, updatedAt: now })
        .where(and(eq(app.id, result.appId), eq(app.createdAt, result.appCreatedAt), eq(app.version, result.version), eq(app.status, current.status)))
        .returning({ id: app.id });
      if (updated.length !== 1) throw freshInstallFailure();
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
