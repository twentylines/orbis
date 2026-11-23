import { appUpdateSettings, appUpdateInputHash } from './app-update-settings';
import { createMockAppInfo } from '@/tests/helpers/app-mocks';
import { appFormSchema } from '../app-lifecycle/dto/app-lifecycle.dto';
import { beforeEach, expect, it, vi } from 'vitest';
import { freshInstallSql } from '@/tests/helpers/fresh-install-sql';
import { migrationHash } from '../backups/app-migration-journal';
import { AppUpdateStage, type AppUpdateStageState } from '../docker/app-update-stage';
import {
  commitOrdinaryAppUpdate,
  ordinaryUpdateResultBinding,
  readCurrentOrdinaryUpdateCommit,
  verifyOrdinaryUpdateResult,
} from './app-update-commit';

let sql: ReturnType<typeof freshInstallSql>;
let state: AppUpdateStageState;
let stage: AppUpdateStage;
beforeEach(() => {
  sql = freshInstallSql();
  Object.assign(sql.row(), { status: 'updating', migrations_baselined: true, pending_restart: false });
  sql.setIds(['001-current']);
  state = {
    id: '00000000-0000-4000-8000-000000000001',
    requestId: '00000000-0000-4000-8000-000000000002',
    appUrn: 'demo:store',
    phase: 'committing',
    context: {
      appId: 7,
      appCreatedAt: 123,
      fromVersion: 1,
      toVersion: 2,
      updateStatus: 'running',
      requestInputSha256: '1'.repeat(64),
      authoritySha256: '2'.repeat(64),
      previousLedger: { baselined: true, migrationIds: ['001-current'] },
      targetMigrationIds: ['001-current'],
      originalContainers: [],
    },
    ordinaryCommit: { pendingRestart: false },
    baseline: { entries: [] },
    prepared: { entries: [], envSha256: '3'.repeat(64) },
    pulledImages: { activationSha256: '4'.repeat(64), imageIds: { web: 'sha256:' + '5'.repeat(64) } },
    retainedPinsSha256: null,
  } as unknown as AppUpdateStageState;
  // Real Drizzle SQL with a transport model. File-stage and runtime custody are covered by joined file tests.
  stage = Object.assign(Object.create(AppUpdateStage.prototype), { read: vi.fn(async () => structuredClone(state)) });
});

it.each(['running', 'stopped'] as const)('commits the %s version and exact receipt atomically without rewriting history', async (status) => {
  if (!state.context || !state.ordinaryCommit) throw new Error('Missing fixture');
  state.context.updateStatus = status;
  state.ordinaryCommit.pendingRestart = status === 'running' ? true : null;
  const result = await ordinaryUpdateResultBinding(stage);
  expect(await commitOrdinaryAppUpdate(sql.database, stage, result)).toBe(true);
  expect(sql.row()).toMatchObject({ version: 2, status, pending_restart: status === 'running' });
  expect(sql.ids()).toEqual(['001-current']);
  expect(sql.receipts()).toHaveLength(1);
  expect(await readCurrentOrdinaryUpdateCommit(sql.database, result)).toBe(true);
});

it('positively acknowledges a lost commit reply without repeating the write', async () => {
  const result = await ordinaryUpdateResultBinding(stage);
  sql.behavior('lost-terminal-commit');
  await expect(commitOrdinaryAppUpdate(sql.database, stage, result)).rejects.toThrow();
  expect(await readCurrentOrdinaryUpdateCommit(sql.database, result)).toBe(true);
  expect(sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(1);
});

it('rolls back the row if inserting its receipt fails', async () => {
  const result = await ordinaryUpdateResultBinding(stage);
  sql.behavior('receipt-insert-failed');
  await expect(commitOrdinaryAppUpdate(sql.database, stage, result)).rejects.toThrow();
  expect(sql.row()).toMatchObject({ version: 1, status: 'updating' });
  expect(sql.receipts()).toEqual([]);
  expect(await readCurrentOrdinaryUpdateCommit(sql.database, result)).toBe(false);
});

it('accepts the same receipt without another write only while the committed row and history still match', async () => {
  const result = await ordinaryUpdateResultBinding(stage);
  await commitOrdinaryAppUpdate(sql.database, stage, result);
  await commitOrdinaryAppUpdate(sql.database, stage, result);
  expect(sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(1);
  sql.row().version = 1;
  await expect(commitOrdinaryAppUpdate(sql.database, stage, result)).rejects.toThrow();
});

it.each(['id', 'created_at', 'app_name', 'app_store_slug', 'version', 'status', 'migrations_baselined'] as const)(
  'refuses a changed %s before final SQL mutation',
  async (field) => {
    const result = await ordinaryUpdateResultBinding(stage);
    const values = { id: 8, created_at: 124, app_name: 'other', app_store_slug: 'other', version: 0, status: 'running', migrations_baselined: false };
    sql.row()[field] = values[field];
    const before = structuredClone(sql.row());
    await expect(commitOrdinaryAppUpdate(sql.database, stage, result)).rejects.toThrow();
    expect(sql.row()).toEqual(before);
    expect(sql.queries.some((query) => query.startsWith('update'))).toBe(false);
  },
);

it.each(['created_at', 'app_name', 'app_store_slug', 'version', 'status', 'migrations_baselined', 'pending_restart', 'ledger'] as const)(
  'refuses to clear recovery from a historical receipt after current %s changed',
  async (field) => {
    const result = await ordinaryUpdateResultBinding(stage);
    await commitOrdinaryAppUpdate(sql.database, stage, result);
    const values = {
      created_at: 124,
      app_name: 'other',
      app_store_slug: 'other',
      version: 1,
      status: 'updating',
      migrations_baselined: false,
      pending_restart: true,
    };
    if (field === 'ledger') sql.setIds(['different']);
    else sql.row()[field] = values[field];
    await expect(readCurrentOrdinaryUpdateCommit(sql.database, result)).rejects.toThrow();
    expect(sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(1);
  },
);

it.each(['app_id', 'stage_id', 'operation_sha256', 'ledger_sha256', 'version', 'committed_at'] as const)(
  'rejects a mismatched receipt %s, including another receipt domain',
  async (field) => {
    const result = await ordinaryUpdateResultBinding(stage);
    await commitOrdinaryAppUpdate(sql.database, stage, result);
    const receipt = sql.receipts()[0];
    if (!receipt) throw new Error('Missing fixture');
    receipt[field] = field === 'committed_at' ? -1 : field === 'app_id' || field === 'version' ? 99 : '0'.repeat(64);
    await expect(readCurrentOrdinaryUpdateCommit(sql.database, result)).rejects.toThrow();
  },
);

it.each(['status', 'proofSha256', 'requestInputSha256', 'pendingRestart', 'fromVersion'] as const)('binds the supplied result %s', async (field) => {
  const result = await ordinaryUpdateResultBinding(stage);
  const changed = {
    ...result,
    [field]: field === 'status' ? 'stopped' : field === 'pendingRestart' ? true : field === 'fromVersion' ? 0 : '0'.repeat(64),
  };
  expect(() => verifyOrdinaryUpdateResult(changed)).toThrow();
  const { operationSha256: _old, ...body } = changed;
  await expect(commitOrdinaryAppUpdate(sql.database, stage, { ...body, operationSha256: migrationHash(body) })).rejects.toThrow();
  expect(sql.queries).toEqual([]);
});

it.each(['pending-migration', 'fresh-install', 'missing-intent', 'early-phase'])('never treats %s as an ordinary terminal update', async (change) => {
  if (!state.context) throw new Error('Missing fixture');
  if (change === 'pending-migration') state.context.targetMigrationIds.push('002-next');
  if (change === 'fresh-install') state.context.purpose = 'fresh-install';
  if (change === 'missing-intent') delete state.ordinaryCommit;
  if (change === 'early-phase') state.phase = 'target-ready';
  await expect(ordinaryUpdateResultBinding(stage)).rejects.toThrow();
  expect(sql.queries).toEqual([]);
});

it('requires persisted commit intent and actual stage identity before SQL writes', async () => {
  const result = await ordinaryUpdateResultBinding(stage);
  state.phase = 'activation-attempted';
  await expect(commitOrdinaryAppUpdate(sql.database, stage, result)).rejects.toThrow();
  await expect(ordinaryUpdateResultBinding({ read: async () => state } as never)).rejects.toThrow();
  expect(sql.queries).toEqual([]);
});

it('commits normalized settings with the ordinary version and keeps them in its acknowledgement', async () => {
  if (!state.context) throw new Error('Missing context');
  const original = { exposed: true, domain: 'example.test' };
  sql.row().config = original;
  const form = appFormSchema.assert({ exposed: false, EXTRA: 'keep' });
  state.context.requestInputSha256 = appUpdateInputHash(original);
  state.context.settings = appUpdateSettings(createMockAppInfo({ port: 8090 }), original, form);
  const result = await ordinaryUpdateResultBinding(stage);
  expect(await commitOrdinaryAppUpdate(sql.database, stage, result)).toBe(true);
  expect(sql.row()).toMatchObject({ version: 2, exposed: false, domain: null, port: 8090 });
  expect(await readCurrentOrdinaryUpdateCommit(sql.database, result)).toBe(true);
  sql.row().config = { EXTRA: 'newer-setting' };
  await expect(readCurrentOrdinaryUpdateCommit(sql.database, result)).rejects.toThrow();
  expect(sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(1);
});

it('refuses a changed source config before writing ordinary target settings', async () => {
  if (!state.context) throw new Error('Missing context');
  const original = { EXTRA: 'old-setting' };
  state.context.requestInputSha256 = appUpdateInputHash(original);
  state.context.settings = appUpdateSettings(createMockAppInfo({ port: 8090 }), original, appFormSchema.assert({ EXTRA: 'target' }));
  sql.row().config = { EXTRA: 'newer-setting' };
  const result = await ordinaryUpdateResultBinding(stage);
  await expect(commitOrdinaryAppUpdate(sql.database, stage, result)).rejects.toThrow();
  expect(sql.queries.some((query) => query.startsWith('update'))).toBe(false);
  expect(sql.receipts()).toEqual([]);
});
