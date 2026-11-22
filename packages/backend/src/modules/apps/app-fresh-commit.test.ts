import { beforeEach, expect, it, vi } from 'vitest';
import { freshInstallSql } from '@/tests/helpers/fresh-install-sql';
import { AppUpdateStage, type AppUpdateStageState } from '../docker/app-update-stage';
import {
  commitFreshInstall,
  freshInstallResultBinding,
  readFreshInstallCommit,
  readCurrentFreshInstallCommit,
  verifyFreshInstallResult,
} from './app-fresh-commit';

let sql: ReturnType<typeof freshInstallSql>;
let stage: AppUpdateStage;
let state: AppUpdateStageState;
beforeEach(() => {
  sql = freshInstallSql();
  sql.row().migrations_baselined = true;
  sql.setIds(['001-current']);
  state = {
    id: '00000000-0000-4000-8000-000000000001',
    requestId: '00000000-0000-4000-8000-000000000002',
    phase: 'committing',
    appUrn: 'demo:store',
    context: {
      purpose: 'fresh-install',
      appId: 7,
      appCreatedAt: 123,
      fromVersion: 1,
      toVersion: 1,
      requestInputSha256: '1'.repeat(64),
      authoritySha256: '2'.repeat(64),
      updateStatus: 'running',
      originalContainers: [],
      previousLedger: { baselined: false, migrationIds: [] },
      targetMigrationIds: ['001-current'],
    },
    prepared: { entries: [], envSha256: '3'.repeat(64) },
    pulledImages: { activationSha256: '4'.repeat(64), imageIds: { web: 'sha256:' + '5'.repeat(64) } },
    freshInstall: { phase: 'baselined', containers: [{}], storageSha256: '6'.repeat(64), imagePinsSha256: '7'.repeat(64) },
  } as unknown as AppUpdateStageState;
  // Actual Drizzle SQL is exercised here; real file/stage/runtime custody is covered by the joined file tests.
  stage = Object.assign(Object.create(AppUpdateStage.prototype), {
    read: vi.fn(async () => structuredClone(state)),
    verifyFreshInstall: vi.fn(async () => structuredClone(state)),
  });
});

it.each(['running', 'stopped'] as const)('atomically records final %s status and the exact same-request completion receipt', async (status) => {
  if (!state.context) throw new Error('Missing fixture context');
  state.context.updateStatus = status;
  const result = await freshInstallResultBinding(stage);
  expect(await commitFreshInstall(sql.database, stage, result)).toBe(true);
  expect(sql.row()).toMatchObject({ status, version: 1, migrations_baselined: true });
  expect(sql.ids()).toEqual(['001-current']);
  expect(await readFreshInstallCommit(sql.database, result)).toBe(true);
  expect(sql.receipts()).toHaveLength(1);
});

it('reconciles a lost final SQL reply without repeating its status write', async () => {
  sql.behavior('lost-terminal-commit');
  const result = await freshInstallResultBinding(stage);
  await expect(commitFreshInstall(sql.database, stage, result)).rejects.toThrow();
  expect(await readFreshInstallCommit(sql.database, result)).toBe(true);
  expect(sql.row().status).toBe('running');
  expect(sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(1);
});

it('rolls back status if the receipt insert fails', async () => {
  sql.behavior('receipt-insert-failed');
  const result = await freshInstallResultBinding(stage);
  await expect(commitFreshInstall(sql.database, stage, result)).rejects.toThrow();
  expect(sql.row().status).toBe('installing');
  expect(sql.receipts()).toEqual([]);
  expect(await readFreshInstallCommit(sql.database, result)).toBe(false);
});

it('does not rewrite SQL after the exact receipt has already committed', async () => {
  const result = await freshInstallResultBinding(stage);
  await commitFreshInstall(sql.database, stage, result);
  await commitFreshInstall(sql.database, stage, result);
  expect(sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(1);
  expect(sql.receipts()).toHaveLength(1);
});

it.each(['id', 'created_at', 'app_name', 'app_store_slug', 'version', 'status', 'migrations_baselined'] as const)(
  'preserves the row and history when completion finds changed %s',
  async (field) => {
    const result = await freshInstallResultBinding(stage);
    const values = {
      id: 8,
      created_at: 124,
      app_name: 'other',
      app_store_slug: 'other',
      version: 2,
      status: 'updating',
      migrations_baselined: false,
    };
    sql.row()[field] = values[field];
    const before = structuredClone(sql.row());
    await expect(commitFreshInstall(sql.database, stage, result)).rejects.toThrow();
    expect(sql.row()).toEqual(before);
    expect(sql.receipts()).toEqual([]);
    expect(sql.queries.some((query) => query.startsWith('update'))).toBe(false);
  },
);

it('does not manufacture completion for a changed migration ledger', async () => {
  const result = await freshInstallResultBinding(stage);
  sql.setIds(['unexpected-history']);
  await expect(commitFreshInstall(sql.database, stage, result)).rejects.toThrow();
  expect(sql.ids()).toEqual(['unexpected-history']);
  expect(sql.row().status).toBe('installing');
});

it.each(['status', 'appCreatedAt', 'proofSha256', 'requestInputSha256', 'migrationIds'] as const)(
  'binds every retained result field rather than trusting edited %s',
  async (field) => {
    const result = await freshInstallResultBinding(stage);
    const values = { status: 'stopped', appCreatedAt: 124, proofSha256: '9'.repeat(64), requestInputSha256: '8'.repeat(64), migrationIds: [] };
    expect(() => verifyFreshInstallResult({ ...result, [field]: values[field] })).toThrow();
  },
);

it.each(['operation_sha256', 'ledger_sha256', 'stage_id', 'version', 'app_id'] as const)(
  'rejects a different SQL receipt field %s, including an ordinary migration receipt',
  async (field) => {
    const result = await freshInstallResultBinding(stage);
    await commitFreshInstall(sql.database, stage, result);
    const receipt = sql.receipts()[0];
    if (!receipt) throw new Error('Missing receipt');
    receipt[field] = field === 'version' || field === 'app_id' ? 99 : '0'.repeat(64);
    await expect(readFreshInstallCommit(sql.database, result)).rejects.toThrow();
  },
);

it('refuses SQL mutation before a durable final commit intent', async () => {
  const result = await freshInstallResultBinding(stage);
  state.phase = 'activation-attempted';
  await expect(commitFreshInstall(sql.database, stage, result)).rejects.toThrow();
  expect(sql.queries).toEqual([]);
});

it('rejects plain supplied stage metadata', async () => {
  await expect(freshInstallResultBinding({ verifyFreshInstall: async () => state } as never)).rejects.toThrow();
});

it.each(['row', 'ledger', 'baseline'])('does not clear unfinished recovery using a historical receipt after %s rollback', async (fault) => {
  const result = await freshInstallResultBinding(stage);
  await commitFreshInstall(sql.database, stage, result);
  if (fault === 'row') sql.row().version = 0;
  if (fault === 'ledger') sql.setIds([]);
  if (fault === 'baseline') sql.row().migrations_baselined = false;
  expect(await readFreshInstallCommit(sql.database, result)).toBe(true); // Historical outcome remains true.
  await expect(readCurrentFreshInstallCommit(sql.database, result)).rejects.toThrow();
  expect(sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(1);
});
