import { beforeEach, expect, it, vi } from 'vitest';
import { freshInstallSql } from '@/tests/helpers/fresh-install-sql';
import { AppUpdateStage, type AppUpdateStageState } from '../docker/app-update-stage';
import { commitFreshInstallBaseline, readFreshInstallBaseline } from './app-fresh-baseline';

let sql: ReturnType<typeof freshInstallSql>;
let stage: AppUpdateStage;
let state: AppUpdateStageState;
beforeEach(() => {
  sql = freshInstallSql();
  // The SQL-only fixture models a valid stage. Separate real-file tests exercise actual stage custody and Host/Engine joins.
  state = {
    phase: 'prepared',
    appUrn: 'demo:store',
    context: {
      purpose: 'fresh-install',
      appId: 7,
      appCreatedAt: 123,
      fromVersion: 1,
      toVersion: 1,
      originalContainers: [],
      previousLedger: { baselined: false, migrationIds: [] },
      targetMigrationIds: ['001-initial', '002-latest'],
    },
    freshInstall: { phase: 'baseline-intent', containers: [{}] },
  } as unknown as AppUpdateStageState;
  stage = Object.assign(Object.create(AppUpdateStage.prototype), { verifyFreshInstall: vi.fn(async () => structuredClone(state)) });
});
it.each([{ ids: [] }, { ids: ['001-initial', '002-latest'] }])(
  'atomically baselines fresh target IDs without changing version or starting the app: %j',
  async ({ ids }) => {
    if (!state.context) throw new Error('Missing context');
    state.context.targetMigrationIds = ids;
    expect(await commitFreshInstallBaseline(sql.database, stage)).toBe(true);
    expect(sql.row()).toMatchObject({ version: 1, status: 'installing', migrations_baselined: true });
    expect(sql.ids()).toEqual(ids);
    expect(await readFreshInstallBaseline(sql.database, stage)).toBe(true);
    expect(sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(1);
  },
);
it('rolls back both flag and IDs when inserting migration history fails', async () => {
  sql.behavior('insert-failed');
  await expect(commitFreshInstallBaseline(sql.database, stage)).rejects.toThrow();
  expect(sql.row().migrations_baselined).toBe(false);
  expect(sql.ids()).toEqual([]);
});
it('reconciles a lost commit reply with read-only exact history and never repeats its SQL write', async () => {
  sql.behavior('lost-commit');
  await expect(commitFreshInstallBaseline(sql.database, stage)).rejects.toThrow();
  expect(await readFreshInstallBaseline(sql.database, stage)).toBe(true);
  expect(sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(1);
});

it('can finish the same never-started reservation after failed-request settlement marked its row stopped', async () => {
  sql.row().status = 'stopped';
  expect(await commitFreshInstallBaseline(sql.database, stage)).toBe(true);
  expect(sql.row()).toMatchObject({ status: 'stopped', migrations_baselined: true });
  expect(await readFreshInstallBaseline(sql.database, stage)).toBe(true);
  expect(sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(1);
});
it.each(['id', 'created_at', 'app_name', 'app_store_slug', 'version', 'status', 'migrations_baselined'] as const)(
  'refuses changed installing row %s',
  async (field) => {
    const changed = { id: 8, created_at: 124, app_name: 'other', app_store_slug: 'other', version: 2, status: 'running', migrations_baselined: true };
    sql.row()[field] = changed[field];
    const before = structuredClone(sql.row());
    await expect(commitFreshInstallBaseline(sql.database, stage)).rejects.toThrow();
    expect(sql.row()).toEqual(before);
    expect(sql.queries.some((query) => query.startsWith('update'))).toBe(false);
  },
);
it('keeps existing migration history instead of replacing it with a fresh ledger', async () => {
  sql.setIds(['old-history']);
  await expect(commitFreshInstallBaseline(sql.database, stage)).rejects.toThrow();
  expect(sql.ids()).toEqual(['old-history']);
  expect(sql.row().migrations_baselined).toBe(false);
});
it.each(['ordinary-stage', 'missing-storage', 'not-intent', 'nonempty-history', 'old-containers', 'changed-version'] as const)(
  'refuses an invalid fresh baseline authority: %s',
  async (fault) => {
    if (!state.context || !state.freshInstall) throw new Error('Missing fixture');
    if (fault === 'ordinary-stage') delete state.context.purpose;
    if (fault === 'missing-storage') delete state.freshInstall;
    if (fault === 'not-intent' && state.freshInstall) state.freshInstall.phase = 'allocating';
    if (fault === 'nonempty-history') state.context.previousLedger.migrationIds = ['old'];
    if (fault === 'old-containers') state.context.originalContainers = [{}] as never;
    if (fault === 'changed-version') state.context.fromVersion = 0;
    await expect(commitFreshInstallBaseline(sql.database, stage)).rejects.toThrow();
    expect(sql.queries).toEqual([]);
  },
);
it('rejects supplied metadata without an actual stage interface', async () => {
  await expect(commitFreshInstallBaseline(sql.database, { read: async () => state } as never)).rejects.toThrow();
  expect(sql.queries).toEqual([]);
});
