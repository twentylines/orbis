import { expect, test } from 'bun:test';
import type { RestoreJob } from './contracts';
import { acceptRestoreAttempt, beginRestoreAttempt, restoreForAttempt } from './restore-attempt';
const job = (id: string, status: RestoreJob['status']): RestoreJob => ({
  id,
  status,
  stage: status === 'succeeded' ? 'complete' : 'checking',
  phase: status === 'succeeded' ? 'completed' : 'prepared',
  message: 'Test restore status',
  needsRecovery: false,
  progressUnavailable: false,
  canCancel: status === 'ready',
  canRecover: false,
});
test('explicit new intent suppresses the previous completed restore until the server accepts a new operation', () => {
  const previous = Object.freeze(job('old-restore', 'succeeded'));
  const attempt = Object.freeze(beginRestoreAttempt(previous));
  expect(restoreForAttempt(attempt, previous)).toBeNull();
  expect(restoreForAttempt(attempt, job('new-restore', 'ready'))).toBeNull();
  expect(() => acceptRestoreAttempt(attempt, previous)).toThrow('earlier restore');
  expect(() => acceptRestoreAttempt(attempt, job('new-restore', 'succeeded'))).toThrow('does not confirm');
  const accepted = acceptRestoreAttempt(attempt, job('new-restore', 'ready'));
  expect(accepted.acceptedId).toBe('new-restore');
  expect(restoreForAttempt(accepted, previous)).toBeNull();
  expect(restoreForAttempt(accepted, job('new-restore', 'running'))?.status).toBe('running');
  expect(restoreForAttempt(accepted, job('new-restore', 'succeeded'))?.status).toBe('succeeded');
});
test('same accepted attempt can reconcile idempotently while another ID cannot replace it', () => {
  const accepted = acceptRestoreAttempt(beginRestoreAttempt(null), job('accepted-restore', 'ready'));
  expect(acceptRestoreAttempt(accepted, job('accepted-restore', 'running'))).toEqual(accepted);
  expect(acceptRestoreAttempt(accepted, job('accepted-restore', 'succeeded'))).toEqual(accepted);
  expect(() => acceptRestoreAttempt(accepted, job('unrelated-restore', 'ready'))).toThrow('different');
  expect(restoreForAttempt(accepted, null)).toBeNull();
});
test('reload without an explicit new intent observes the real completed operation and performs no automatic restart', () => {
  const completed = Object.freeze(job('completed-restore', 'succeeded'));
  expect(restoreForAttempt(null, completed)).toBe(completed);
  expect(restoreForAttempt(null, undefined)).toBeNull();
  const nextClick = beginRestoreAttempt(completed);
  expect(nextClick.acceptedId).toBeNull();
  expect(restoreForAttempt(nextClick, completed)).toBeNull();
});
