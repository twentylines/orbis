import { expect, test } from 'bun:test';
import type { TaskRecord } from '@runtipi/common/schemas/task-history';
import { dismissSetupFailureTask, mergeSetupCaptureTasks, recordSetupFailureTask, setupFailureTasks } from './setup-capture-task';

const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

test('confirmed setup capture failures remain one stable task through reloads until dismissed', () => {
  const storage = memoryStorage();
  const createdAt = '2026-11-03T02:30:00.000Z';
  expect(recordSetupFailureTask(7, attemptId, 'capture-failed', createdAt, storage)).toBe(true);
  expect(recordSetupFailureTask(7, attemptId, 'capture-failed', '2026-11-03T03:00:00.000Z', storage)).toBe(true);
  expect(setupFailureTasks(8, storage)).toEqual([]);
  const task = setupFailureTasks(7, storage);
  expect(task).toHaveLength(1);
  expect(task[0]).toMatchObject({
    id: attemptId,
    appUrn: 'orbis:time-machine',
    action: 'backup',
    status: 'failed',
    createdAt,
    setupFailureOutcome: 'capture-failed',
  });
  expect(
    mergeSetupCaptureTasks(
      [
        {
          id: attemptId,
          appUrn: 'orbis:time-machine' as TaskRecord['appUrn'],
          displayName: 'Time Machine setup capture',
          action: 'backup',
          status: 'failed',
          createdAt,
          updatedAt: createdAt,
          startedAt: null,
          finishedAt: createdAt,
          attentionRevision: 0,
        },
      ],
      task,
    ),
  ).toHaveLength(1);
  expect(dismissSetupFailureTask(7, attemptId, storage)).toBe(true);
  expect(setupFailureTasks(7, storage)).toEqual([]);
  expect(setupFailureTasks(7, storage)).toEqual([]);
  expect(recordSetupFailureTask(7, attemptId, 'capture-failed', createdAt, storage)).toBe(true);
  expect(setupFailureTasks(7, storage)).toEqual([]);
});

test('a rejected capture start is recorded with distinct wording and a stable task ID', () => {
  const storage = memoryStorage();
  expect(recordSetupFailureTask(7, attemptId, 'capture-not-started', undefined, storage)).toBe(true);
  expect(setupFailureTasks(7, storage)[0]).toMatchObject({ id: attemptId, setupFailureOutcome: 'capture-not-started' });
  expect(recordSetupFailureTask(7, 'invalid-id', 'capture-failed', undefined, storage)).toBe(false);
});

test('a failed preference save is a separate stable task with only its safe reason', () => {
  const storage = memoryStorage();
  const safeReason = 'The Time Machine settings changed in another session. Refresh before saving.';
  expect(recordSetupFailureTask(7, attemptId, 'preferences-save-failed', '2026-11-03T02:30:00.000Z', storage, safeReason)).toBe(true);
  expect(setupFailureTasks(7, storage)[0]).toMatchObject({
    id: attemptId,
    appUrn: 'orbis:settings',
    action: 'update',
    status: 'failed',
    setupFailureOutcome: 'preferences-save-failed',
    setupFailureReason: safeReason,
  });
  expect(recordSetupFailureTask(7, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'preferences-save-failed', undefined, storage, 'secret <value>')).toBe(
    false,
  );
});
