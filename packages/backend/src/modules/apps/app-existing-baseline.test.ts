import { beforeEach, expect, it, vi } from 'vitest';
import { createAppUrn } from '@/common/helpers/app-helpers';
import { freshInstallSql } from '@/tests/helpers/fresh-install-sql';
import { AppUpdateStage } from '../docker/app-update-stage';
import type { ExistingAppBaseline } from '../docker/app-existing-storage';
import { commitExistingAppBaseline, existingBaselineReceiptBinding, readExistingAppBaseline } from './app-existing-baseline';
import type { ExistingBaselineBinding } from './app-existing-baseline-schema';
const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../docker/app-existing-storage', () => ({ verifyExistingAppBaseline: verify }));
let sql: ReturnType<typeof freshInstallSql>;
let binding: ExistingBaselineBinding;
let stage: AppUpdateStage;
const proof = {} as ExistingAppBaseline;
beforeEach(() => {
  sql = freshInstallSql();
  sql.row().status = 'updating';
  binding = {
    schema: 'orbis.existing-app-baseline.v1',
    requestId: '00000000-0000-4000-8000-000000000001',
    stageId: '00000000-0000-4000-8000-000000000002',
    appUrn: createAppUrn('demo', 'store'),
    appId: 7,
    appCreatedAt: 123,
    version: 1,
    requestInputSha256: '1'.repeat(64),
    authoritySha256: '2'.repeat(64),
    metadataSha256: '3'.repeat(64),
    storageSha256: '4'.repeat(64),
    configurationSha256: '5'.repeat(64),
    migrationIds: ['001-installed', '002-installed'],
    originalContainers: [
      {
        id: '6'.repeat(64),
        imageId: 'sha256:' + '7'.repeat(64),
        service: 'web',
        configSha256: '8'.repeat(64),
        mountsSha256: '9'.repeat(64),
        startedAt: '2026-11-23T00:00:00Z',
        running: true,
        paused: false,
        restarting: false,
      },
    ],
  } as ExistingBaselineBinding;
  verify.mockReset().mockImplementation(async () => structuredClone(binding));
  // SQL-only transport tests. The actual opaque proof and private file custody have separate file tests.
  stage = Object.assign(Object.create(AppUpdateStage.prototype), { read: async () => ({ existingBaseline: { phase: 'intent', binding } }) });
});
it('atomically adopts current deployed IDs without changing version or app status', async () => {
  expect(await commitExistingAppBaseline(sql.database, stage, proof)).toBe(true);
  expect(sql.row()).toMatchObject({ migrations_baselined: true, version: 1, status: 'updating' });
  expect(sql.ids()).toEqual(binding.migrationIds);
  expect(await readExistingAppBaseline(sql.database, binding)).toBe(true);
  expect(sql.receipts()).toHaveLength(1);
  const receipt = existingBaselineReceiptBinding(binding);
  expect(receipt.requestId).not.toBe(binding.requestId);
  expect(receipt.stageId).not.toBe(binding.stageId);
  expect(verify).toHaveBeenCalledTimes(2);
});
it.each(['insert-failed', 'receipt-insert-failed'])('rolls back baseline and IDs on %s', async (fault) => {
  sql.behavior(fault);
  await expect(commitExistingAppBaseline(sql.database, stage, proof)).rejects.toThrow();
  expect(sql.row().migrations_baselined).toBe(false);
  expect(sql.ids()).toEqual([]);
  expect(sql.receipts()).toEqual([]);
});
it('positively reads a lost SQL commit reply without repeating the write', async () => {
  sql.behavior('lost-commit');
  await expect(commitExistingAppBaseline(sql.database, stage, proof)).rejects.toThrow();
  expect(await readExistingAppBaseline(sql.database, binding)).toBe(true);
  await commitExistingAppBaseline(sql.database, stage, proof);
  expect(sql.queries.filter((query) => query.startsWith('update'))).toHaveLength(1);
});
it.each(['id', 'created_at', 'version', 'app_name', 'app_store_slug', 'status', 'migrations_baselined'])(
  'refuses changed %s without mutation',
  async (key) => {
    sql.row()[key] = {
      id: 8,
      created_at: 124,
      version: 2,
      app_name: 'other',
      app_store_slug: 'other',
      status: 'running',
      migrations_baselined: true,
    }[key];
    const before = structuredClone(sql.row());
    await expect(commitExistingAppBaseline(sql.database, stage, proof)).rejects.toThrow();
    expect(sql.row()).toEqual(before);
    expect(sql.ids()).toEqual([]);
    expect(sql.receipts()).toEqual([]);
  },
);
it('refuses a preexisting unbaselined ledger', async () => {
  sql.setIds(['unexpected']);
  await expect(commitExistingAppBaseline(sql.database, stage, proof)).rejects.toThrow();
  expect(sql.ids()).toEqual(['unexpected']);
  expect(sql.receipts()).toEqual([]);
});
it('revalidates the live proof inside the row lock before any write', async () => {
  verify.mockResolvedValueOnce(binding).mockRejectedValueOnce(new Error('Storage changed'));
  await expect(commitExistingAppBaseline(sql.database, stage, proof)).rejects.toThrow();
  expect(sql.row().migrations_baselined).toBe(false);
  expect(sql.queries.some((query) => query.startsWith('update'))).toBe(false);
});
it.each(['ledger', 'row', 'receipt'])('requires the complete current baseline after %s changes', async (fault) => {
  await commitExistingAppBaseline(sql.database, stage, proof);
  if (fault === 'ledger') sql.setIds([]);
  if (fault === 'row') sql.row().version = 2;
  if (fault === 'receipt') {
    const row = sql.receipts()[0];
    if (row) row.operation_sha256 = '0'.repeat(64);
  }
  await expect(readExistingAppBaseline(sql.database, binding)).rejects.toThrow();
});
