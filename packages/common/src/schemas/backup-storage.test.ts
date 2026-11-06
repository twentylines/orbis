import { expect, test } from 'bun:test';
import {
  backupStorageFolderSchema,
  backupStorageLocationSchema,
  backupStorageSettingsSchema,
  defaultBackupStorageSettings,
  reconcileBackupStorageIssue,
} from './backup-storage.js';

test('drive-relative folders accept ordinary spaces and Unicode without changing their spelling', () => {
  for (const value of ['', 'Orbis/Backups', 'My drive/Family backups', 'Sauvegardes/café', 'Captures/😀'])
    expect(backupStorageFolderSchema.assert(value)).toBe(value);
  for (const value of [
    '/etc',
    '../outside',
    'Backups/../outside',
    'Backups//Folder',
    'Backups/./Folder',
    'C:\\Backups',
    'Backups\nFolder',
    'a'.repeat(256),
  ])
    expect(backupStorageFolderSchema.allows(value)).toBe(false);
  expect(backupStorageLocationSchema.allows({ driveId: 'a'.repeat(64), folder: 'Orbis/Backups' })).toBe(true);
  expect(backupStorageLocationSchema.allows({ driveId: '/dev/sda1', folder: 'Orbis/Backups' })).toBe(false);
  expect(backupStorageLocationSchema.allows({ driveId: 'a'.repeat(64), folder: '', hostPath: '/etc' })).toBe(false);
});
test('backup and Time Machine defaults are independently selectable and never imply moving existing data', () => {
  const value = {
    ...defaultBackupStorageSettings(),
    backups: { driveId: 'a'.repeat(64), folder: 'Backup files' },
    timeMachine: { driveId: 'b'.repeat(64), folder: 'Captures' },
  };
  expect(backupStorageSettingsSchema.allows(value)).toBe(true);
  expect(backupStorageSettingsSchema.allows({ ...value, backups: null })).toBe(true);
  expect(backupStorageSettingsSchema.allows({ ...value, deletePrevious: true })).toBe(false);
});
test('storage attention deduplicates retries, offers both repair actions and clears only the affected successful location', () => {
  const issue = reconcileBackupStorageIssue(null, 'backups', 'drive-unavailable', 100);
  expect(issue?.actions).toEqual(['change-location', 'reset-defaults']);
  expect(reconcileBackupStorageIssue(issue, 'backups', 'drive-unavailable', 200)).toEqual(issue);
  expect(reconcileBackupStorageIssue(issue, 'backups', 'folder-unavailable', 300)?.firstSeenAt).toBe(100);
  expect(reconcileBackupStorageIssue(issue, 'backups', null, 400)).toBeNull();
  expect(() => reconcileBackupStorageIssue(issue, 'time-machine', null, 400)).toThrow();
});
