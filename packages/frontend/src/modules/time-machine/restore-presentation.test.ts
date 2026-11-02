import { describe, expect, test } from 'bun:test';
import type { RestoreJob } from '@/modules/system-backups/contracts';
import { measuredPercent, restorePresentation, restoreFailureReason } from '@/components/recovery-progress/restore-presentation';

const preparation = { stage: 'files' as const, completedBytes: 100, totalBytes: 100, records: 0, totalRecords: null };
const base: RestoreJob = {
  id: '00000000-0000-4000-8000-000000000000',
  status: 'running',
  stage: 'files',
  phase: 'preparing',
  message: '',
  needsRecovery: false,
  progressUnavailable: false,
  canCancel: true,
  canRecover: false,
  preparation,
};
describe('restore presentation', () => {
  test('preparation bytes never imply a completed restore', () => {
    expect(restorePresentation(base, false)).toMatchObject({ status: 'Preparing files', progress: 99, detail: '100 B of 100 B prepared' });
    expect(restorePresentation({ ...base, preparation: { ...preparation, completedBytes: 101 } }, false).progress).toBeUndefined();
  });
  test('database reports records without a fabricated overall percentage', () => {
    const job = { ...base, stage: 'database', preparation: { ...preparation, stage: 'database' as const, records: 5, totalRecords: 10 } };
    expect(restorePresentation(job, false)).toMatchObject({ status: 'Preparing database', detail: '5 of 10 records prepared', progress: undefined });
  });
  test('applying restore does not reuse stale preparation progress', () => {
    expect(restorePresentation({ ...base, stage: 'restoring' }, false)).toMatchObject({ status: 'Restoring server', progress: undefined });
  });
  test('reconnect and terminal state take priority', () => {
    expect(restorePresentation(base, true)).toMatchObject({ title: 'Reconnecting', progress: undefined });
    expect(restorePresentation({ ...base, status: 'succeeded' }, false)).toMatchObject({ title: 'Restore complete', progress: 100 });
  });
});

test('measured progress never completes from transferred bytes or accepts inconsistent totals', () => {
  expect(measuredPercent(50, 100)).toBe(50);
  expect(measuredPercent(100, 100)).toBe(99);
  expect(measuredPercent(101, 100)).toBeUndefined();
  expect(measuredPercent(1, null)).toBeUndefined();
});

test('terminal failure copy uses fixed recognized checks and never displays an arbitrary diagnostic', () => {
  const job = { ...base, status: 'rolled-back' as const, check: 'promote-roots' };
  expect(restoreFailureReason(job)).toBe('The backup files could not be applied.');
  expect(restorePresentation(job, false).detail).toBe('The backup files could not be applied.');
  expect(restoreFailureReason({ ...job, check: 'private arbitrary exception' })).toBeUndefined();
  expect(restoreFailureReason({ ...job, status: 'succeeded' })).toBeUndefined();
});
