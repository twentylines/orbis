import { type } from 'arktype';

export const backupStoragePurposeSchema = type.enumerated('backups', 'time-machine');
export type BackupStoragePurpose = typeof backupStoragePurposeSchema.infer;
const identity = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const utf8 = new TextEncoder();
const safeText = (value: string) =>
  [...value].every((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point >= 32 && point !== 127 && character !== '\\' && !(point >= 0xd800 && point <= 0xdfff);
  });
export const backupStorageFolderSchema = type('string').narrow(
  (value) =>
    utf8.encode(value).length <= 4096 &&
    safeText(value) &&
    !value.startsWith('/') &&
    (value === '' || value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && utf8.encode(part).length <= 255)),
);

// The folder is relative to a server-enumerated volume identity, never an arbitrary client host path.
export const backupStorageLocationSchema = type({ driveId: identity, folder: backupStorageFolderSchema }).onUndeclaredKey('reject');
export type BackupStorageLocation = typeof backupStorageLocationSchema.infer;
export const backupStorageSettingsSchema = type({
  version: '1',
  revision: '0 <= number.integer <= 9007199254740991',
  backups: backupStorageLocationSchema.or('null'),
  timeMachine: backupStorageLocationSchema.or('null'),
}).onDeepUndeclaredKey('reject');
export const defaultBackupStorageSettings = () => ({ version: 1 as const, revision: 0, backups: null, timeMachine: null });

export const backupStorageIssueSchema = type({
  purpose: backupStoragePurposeSchema,
  reason: type.enumerated('drive-unavailable', 'folder-unavailable', 'read-only', 'permissions', 'full', 'identity-changed'),
  firstSeenAt: '0 < number.integer <= 9007199254740991',
  actions: type("'change-location' | 'reset-defaults'").array(),
})
  .onDeepUndeclaredKey('reject')
  .narrow((value) => value.actions.join(',') === 'change-location,reset-defaults');
export type BackupStorageIssue = typeof backupStorageIssueSchema.infer;

/** At most one unresolved issue per purpose; a successful recheck removes that issue. */
export function reconcileBackupStorageIssue(
  current: BackupStorageIssue | null,
  purpose: BackupStoragePurpose,
  reason: BackupStorageIssue['reason'] | null,
  now: number,
): BackupStorageIssue | null {
  backupStoragePurposeSchema.assert(purpose);
  if (current) {
    backupStorageIssueSchema.assert(current);
    if (current.purpose !== purpose) throw new Error('Storage issue belongs to another backup location.');
  }
  if (reason === null) return null;
  return backupStorageIssueSchema.assert({
    purpose,
    reason,
    firstSeenAt: current?.firstSeenAt ?? now,
    actions: ['change-location', 'reset-defaults'],
  });
}
