import { randomUUID } from 'node:crypto';
import { app, appMigration, appMigrationCommit } from '@/core/database/drizzle/schema';
import { AppsRepository } from '@/modules/apps/apps.repository';
import { appUpdateInputHash } from '@/modules/apps/app-update-settings';
import type { MigrationJournalState } from '@/modules/backups/app-migration-journal';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'vitest';
import { cleanTestData, createTestDatabase, dropTestDatabase, type TestDatabase } from '../utils/create-test-database';

// This exercises real PostgreSQL transactions, constraints and receipt reads.
// Engine execution, checkpoint storage and target health have separate tests.
const suite = `migration_atomic_${randomUUID().replaceAll('-', '')}`;
let db: TestDatabase;
let repository: AppsRepository;
let state: MigrationJournalState;
const previousLedger = { baselined: true, migrationIds: ['001-initial'] };

beforeAll(async () => {
  db = await createTestDatabase(suite);
  repository = new AppsRepository(db);
});

beforeEach(async () => {
  await cleanTestData(db);
  await db.delete(appMigrationCommit);
  const [current] = await db
    .insert(app)
    .values({ appName: 'demo', appStoreSlug: 'store', config: { before: true }, version: 4, status: 'updating', pendingRestart: true })
    .returning();
  if (!current) throw new Error('Missing migration fixture app');
  await repository.replaceMigrationLedger(current.id, previousLedger);
  state = {
    schema: 'orbis.app-migration-journal.v1',
    revision: 7,
    operation: {
      version: 1,
      requestId: randomUUID(),
      stageId: randomUUID(),
      appUrn: 'demo:store',
      appId: current.id,
      createdAt: current.createdAt,
      fromVersion: 4,
      toVersion: 5,
      settings: {
        sourceSha256: appUpdateInputHash(current.config),
        values: {
          config: { after: true },
          exposed: false,
          exposedLocal: true,
          openPort: false,
          domain: null,
          localSubdomain: 'demo',
          isVisibleOnGuestDashboard: true,
          enableAuth: true,
          maxBackups: 5,
        },
      },
      previousLedger: structuredClone(previousLedger),
      images: [
        {
          migrationId: '002-upgrade',
          sourceSha256: 'a'.repeat(64),
          definitionSha256: 'b'.repeat(64),
          reference: `postgres@sha256:${'c'.repeat(64)}`,
          imageId: `sha256:${'d'.repeat(64)}`,
          platform: 'linux/amd64',
        },
      ],
      originalContainers: [],
    },
    storageSha256: 'e'.repeat(64),
    sourceController: { id: '1'.repeat(64), imageId: `sha256:${'2'.repeat(64)}`, startedAt: 'fixture', definitionSha256: '3'.repeat(64) },
    phase: 'commit-intent',
    targetWritesPossible: true,
    commitAttempted: true,
    commitReceiptSha256: null,
    checkpoint: { file: 'before.tar.gz', sha256: '4'.repeat(64), bytes: 100, fileIdentity: 'fixture-file' },
    runners: [
      {
        migrationId: '002-upgrade',
        nonce: '5'.repeat(32),
        name: `orbis-migration-${'6'.repeat(32)}-${'5'.repeat(12)}`,
        specSha256: '7'.repeat(64),
        containerId: '8'.repeat(64),
        phase: 'terminal',
        exitCode: 0,
        terminalSha256: '9'.repeat(64),
      },
    ],
    restores: [],
  };
});

afterEach(async () => {
  for (const table of ['app', 'app_migration', 'app_migration_commit'])
    await db.execute(sql.raw(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS migration_fixture_rejection`));
});

afterAll(async () => {
  if (db) await db.$client.end();
  await dropTestDatabase(suite);
});

const snapshot = async () => ({
  app: await db.select().from(app).where(eq(app.id, state.operation.appId)),
  ledger: await repository.getMigrationLedger(state.operation.appId),
  receipts: await db.select().from(appMigrationCommit),
});

test('commits version, settings, the full ledger and receipt together and reads them through a new repository', async () => {
  const result = await repository.commitMigration(state, 'running', false);
  expect(result.replayed).toBe(false);
  const fresh = new AppsRepository(db);
  expect(await fresh.getAppById(state.operation.appId)).toMatchObject({
    ...state.operation.settings?.values,
    version: 5,
    status: 'running',
    pendingRestart: false,
    migrationsBaselined: true,
  });
  expect(await fresh.getMigrationLedger(state.operation.appId)).toEqual({ baselined: true, migrationIds: ['001-initial', '002-upgrade'] });
  expect(await fresh.readMigrationCommit(state)).toEqual({ receipt: result.receipt, sha256: result.sha256 });
  const before = await snapshot();
  expect(await fresh.commitMigration(state, 'running', false)).toEqual({ ...result, replayed: true });
  expect(await snapshot()).toEqual(before);
});

test.each([
  ['app', 'version <> 5'],
  ['app_migration', "migration_id <> '002-upgrade'"],
  ['app_migration_commit', 'version <> 5'],
])('rolls back every database change when %s rejects the migration transaction', async (table, condition) => {
  const before = await snapshot();
  await db.execute(sql.raw(`ALTER TABLE ${table} ADD CONSTRAINT migration_fixture_rejection CHECK (${condition})`));
  await expect(repository.commitMigration(state, 'running', false)).rejects.toThrow('requires verified recovery');
  expect(await snapshot()).toEqual(before);
  expect(await repository.readMigrationCommit(state)).toBeUndefined();
});

test('rolls back version and ledger replacement together when duplicate migration IDs violate the database key', async () => {
  const before = await snapshot();
  await expect(
    repository.replaceMigrationLedger(state.operation.appId, { baselined: true, migrationIds: ['duplicate', 'duplicate'] }, { version: 5 }),
  ).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
});

test('refuses an altered operation replay without changing the committed app or receipt', async () => {
  await repository.commitMigration(state, 'running', false);
  const before = await snapshot();
  const altered = structuredClone(state);
  altered.operation.toVersion = 6;
  await expect(repository.commitMigration(altered, 'running', false)).rejects.toThrow('requires verified recovery');
  expect(await snapshot()).toEqual(before);
});

test('does not report a valid receipt after committed settings have changed', async () => {
  await repository.commitMigration(state, 'running', false);
  await db
    .update(app)
    .set({ config: { changed: true } })
    .where(eq(app.id, state.operation.appId));
  const before = await snapshot();
  await expect(new AppsRepository(db).readMigrationCommit(state)).rejects.toThrow('requires verified recovery');
  expect(await snapshot()).toEqual(before);
});

test('cascades app ledger deletion while retaining the operational receipt and refusing reuse', async () => {
  const result = await repository.commitMigration(state, 'running', false);
  await db.delete(app).where(eq(app.id, state.operation.appId));
  expect(await db.select().from(appMigration)).toEqual([]);
  expect(await db.select().from(appMigrationCommit)).toEqual([result.receipt]);
  await expect(repository.commitMigration(state, 'running', false)).rejects.toThrow('requires verified recovery');
  expect(await db.select().from(app)).toEqual([]);
  expect(await db.select().from(appMigrationCommit)).toEqual([result.receipt]);
});

test('settles rollback status without advancing version, settings, migration history or a forward receipt', async () => {
  const ready = { ...structuredClone(state), phase: 'ready' as const, targetWritesPossible: false, commitAttempted: false, runners: [] };
  expect(await repository.settleMigrationRollback(ready, 'running', true)).toBe(true);
  expect(await repository.readMigrationRollback(ready, 'running')).toBe(true);
  expect(await repository.getAppById(state.operation.appId)).toMatchObject({
    version: 4,
    config: { before: true },
    status: 'running',
    pendingRestart: true,
  });
  expect(await repository.getMigrationLedger(state.operation.appId)).toEqual(previousLedger);
  expect(await db.select().from(appMigrationCommit)).toEqual([]);
});

test('commits concurrent deliveries at most once and permits a later exact replay', async () => {
  const results = await Promise.allSettled([
    repository.commitMigration(state, 'running', false),
    new AppsRepository(db).commitMigration(state, 'running', false),
  ]);
  const successes = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  expect(successes.filter((result) => !result.replayed)).toHaveLength(1);
  expect(successes.length).toBeGreaterThanOrEqual(1);
  expect(await db.select().from(appMigrationCommit)).toHaveLength(1);
  expect(await repository.commitMigration(state, 'running', false)).toMatchObject({ replayed: true });
  expect(await repository.getMigrationLedger(state.operation.appId)).toEqual({ baselined: true, migrationIds: ['001-initial', '002-upgrade'] });
});
