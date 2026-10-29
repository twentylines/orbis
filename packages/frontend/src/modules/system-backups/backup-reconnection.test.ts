import { expect, test } from 'bun:test';
import type { BackupSnapshot } from './contracts';
import { BackupApiError } from './backup-api';
import { isAcceptedRestoreReconnect, shouldStopBackupStatusPolling } from './backup-reconnection';

const snapshot = (status: string): BackupSnapshot => ({ restore: { job: { status } } }) as unknown as BackupSnapshot;

test('accepted ready and running restores keep polling through temporary 404s', () => {
  for (const restoreStatus of ['ready', 'running']) {
    const lastConfirmed = snapshot(restoreStatus);
    const error = new BackupApiError(404);
    expect(shouldStopBackupStatusPolling(error, lastConfirmed)).toBe(false);
    expect(isAcceptedRestoreReconnect(error, restoreStatus, true)).toBe(true);
  }
});

test('accepted restores show reconnect status only for transient 404, 5xx and network failures', () => {
  for (const error of [new BackupApiError(0), new BackupApiError(404), new BackupApiError(503), new TypeError('fetch failed')])
    expect(isAcceptedRestoreReconnect(error, 'running', true)).toBe(true);

  for (const error of [new BackupApiError(401), new BackupApiError(403), new BackupApiError(409)])
    expect(isAcceptedRestoreReconnect(error, 'running', true)).toBe(false);
  expect(isAcceptedRestoreReconnect(new BackupApiError(404), 'recovery-required', true)).toBe(false);
  expect(isAcceptedRestoreReconnect(new BackupApiError(404), 'running', false)).toBe(false);
});

test('authentication, access refusal and recovery-state 404s retain existing error handling', () => {
  const accepted = snapshot('running');
  expect(shouldStopBackupStatusPolling(new BackupApiError(401), accepted)).toBe(true);
  expect(shouldStopBackupStatusPolling(new BackupApiError(403), accepted)).toBe(true);
  expect(shouldStopBackupStatusPolling(new BackupApiError(404), snapshot('recovery-required'))).toBe(true);
  expect(shouldStopBackupStatusPolling(new BackupApiError(404), snapshot('succeeded'))).toBe(true);
  expect(isAcceptedRestoreReconnect(new BackupApiError(404), 'succeeded', true)).toBe(false);
  expect(shouldStopBackupStatusPolling(new BackupApiError(404), undefined)).toBe(true);
});
