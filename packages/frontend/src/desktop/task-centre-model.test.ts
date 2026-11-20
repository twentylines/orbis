import { expect, test } from 'bun:test';
import type { TaskRecord } from '@runtipi/common/schemas/task-history';
import type { TimeMachinePoint } from '@runtipi/common/schemas/time-machine';
import { taskCentreRecords, groupTaskCentreAttempts, filterTaskCentreRecords, taskDuration } from './task-centre-model';
import type { TaskCentreFilters } from './task-centre-model';
import type { RestoreRequests } from '@/modules/host-transfer/receiver-request-api';
import { dismissSetupFailureTask, recordSetupFailureTask, setupFailureTasks } from '@/components/welcome/setup-capture-task';
const at = Date.parse('2026-11-19T00:00:00Z');
function task(index: number, status: TaskRecord['status'] = 'failed', seconds = index * 12): TaskRecord {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    appUrn: 'archivebox:main' as TaskRecord['appUrn'],
    displayName: 'ArchiveBox',
    action: 'update',
    status,
    createdAt: new Date(at + seconds * 1000).toISOString(),
    updatedAt: new Date(at + seconds * 1000).toISOString(),
    startedAt: null,
    finishedAt: null,
  };
}
const filters: TaskCentreFilters = { view: 'all', query: '', source: 'all', outcome: 'all', days: 'all' };

test('one unified record per task supports active, attention and complete history without default duplicates', () => {
  const records = taskCentreRecords({
    tasks: ['queued', 'running', 'failed', 'interrupted', 'unconfirmed', 'succeeded'].map((status, index) =>
      task(index + 1, status as TaskRecord['status']),
    ),
  });
  expect(records).toHaveLength(6);
  expect(new Set(records.map((r) => r.key)).size).toBe(6);
  expect(records.filter((r) => r.bucket === 'active')).toHaveLength(2);
  expect(records.filter((r) => r.bucket === 'review')).toHaveLength(3);
  expect(records.filter((r) => r.bucket === 'recent')).toHaveLength(1);
  expect(filterTaskCentreRecords(records, { ...filters, view: 'history' })).toHaveLength(4);
});

test('an already dismissed setup notice is searchable in History only, retaining its actual failed outcome', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  const id = task(1).id;
  expect(recordSetupFailureTask(1, id, 'capture-failed', undefined, storage)).toBe(true);
  expect(dismissSetupFailureTask(1, id, storage)).toBe(true);
  const records = taskCentreRecords({ tasks: setupFailureTasks(1, storage, true) });
  expect(filterTaskCentreRecords(records, filters)).toEqual([]);
  expect(filterTaskCentreRecords(records, { ...filters, view: 'review' })).toEqual([]);
  expect(filterTaskCentreRecords(records, { ...filters, view: 'history', query: 'dismissed' })).toMatchObject([
    { status: 'Failed · dismissed', outcome: 'failed', dismissed: true },
  ]);
});

test('groups close repeated failures while preserving every attempt, chronological boundaries and unrelated operations', () => {
  const source = [
    task(1),
    task(2),
    task(3, 'succeeded', 30),
    task(4, 'failed', 40),
    task(5, 'failed', 900),
    { ...task(6, 'failed', 42), appUrn: 'other:main' as TaskRecord['appUrn'] },
  ];
  const records = taskCentreRecords({ tasks: source });
  const grouped = groupTaskCentreAttempts(records);
  expect(grouped).toHaveLength(5);
  expect(grouped.find((r) => r.attempts.length === 2)?.attempts.map((r) => r.task?.id)).toEqual([task(2).id, task(1).id]);
  expect(
    grouped
      .flatMap((r) => r.attempts)
      .map((r) => r.key)
      .sort(),
  ).toEqual(records.map((r) => r.key).sort());
  expect(source).toHaveLength(6);
});

test('does not discard system records beyond three or conflate equal IDs in different sources', () => {
  const system = Array.from({ length: 6 }, (_, index) => ({
    key: `export:${task(index).id}`,
    feed: 'exports' as const,
    title: 'Settings backup',
    status: 'Backup ready',
    state: 'ready',
    bucket: 'recent' as const,
    time: at + index,
    path: '/settings?tab=backups',
    action: 'View backup',
  }));
  const records = taskCentreRecords({ tasks: [task(1)], system });
  expect(records).toHaveLength(7);
  expect(groupTaskCentreAttempts(records)).toHaveLength(7);
});

test('search, application, status and date filters operate on actual records, retaining failed outcomes in history', () => {
  const records = taskCentreRecords({
    tasks: [task(1), task(2, 'succeeded'), { ...task(3), appUrn: 'notes:extra' as TaskRecord['appUrn'], displayName: 'Notes' }],
  });
  expect(filterTaskCentreRecords(records, { ...filters, query: 'archivebox failed', view: 'history' })).toHaveLength(1);
  expect(filterTaskCentreRecords(records, { ...filters, source: 'notes:extra', outcome: 'failed' })).toHaveLength(1);
  expect(filterTaskCentreRecords(records, { ...filters, query: task(1).id })).toHaveLength(1);
  expect(filterTaskCentreRecords(records, { ...filters, days: '1' }, at + 2 * 86_400_000)).toHaveLength(0);
  expect(records).toHaveLength(3);
});

test('capture projection replaces its historical record by stable ID and stale progress never becomes a confirmed completion', () => {
  const capture: TimeMachinePoint = {
    id: task(1).id,
    createdAt: at,
    status: 'capturing',
    stage: 'encrypting',
    completedBytes: 512,
    totalBytes: 1024,
    issue: null,
    backupJobId: null,
    metadata: null,
  };
  const records = taskCentreRecords({
    tasks: [],
    capture,
    captureFailed: true,
    system: [
      {
        key: `point:${capture.id}`,
        feed: 'points',
        title: 'Time Machine capture',
        status: 'Capturing',
        bucket: 'active',
        path: '/settings?tab=time-machine',
        action: 'Open Time Machine',
      },
    ],
  });
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ bucket: 'active', stale: true, status: 'Status unavailable', progress: { completed: 512, total: 1024 } });
});

test('elapsed time is not invented for missing timestamps or stale active records', () => {
  const record = taskCentreRecords({ tasks: [{ ...task(1, 'running'), startedAt: new Date(at).toISOString() }] })[0];
  if (!record) throw Error('Expected record');
  expect(taskDuration(record, at + 65000)).toBe('1m 5s');
  expect(taskDuration({ ...record, stale: true }, at + 65000)).toBeNull();
  expect(taskDuration({ ...record, startedAt: undefined }, at + 65000)).toBeNull();
});

test('expiry is unconfirmed transfer state, not proof that a backup worker stopped or completed', () => {
  const requests: RestoreRequests = {
    version: 1,
    incoming: [
      {
        version: 1,
        id: task(1).id,
        nonce: task(2).id,
        sourceFingerprint: 'a'.repeat(64),
        destinationFingerprint: 'b'.repeat(64),
        status: 'exporting',
        expiresAt: at - 1,
        completedBytes: 0,
        totalBytes: null,
      },
    ],
    outgoing: [],
  };
  expect(taskCentreRecords({ tasks: [], requests, now: at })[0]).toMatchObject({
    bucket: 'review',
    outcome: 'unconfirmed',
    status: 'Expired · outcome unconfirmed',
  });
});
