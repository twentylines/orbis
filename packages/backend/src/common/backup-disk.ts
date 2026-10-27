export class BackupDiskBusyError extends Error {
  constructor() {
    super('Another backup transfer is using the backup workspace. Wait for it to finish, then retry.');
  }
}

let active = false;
export const backupDiskActive = () => active;

export function acquireBackupDisk() {
  if (active) throw new BackupDiskBusyError();
  active = true;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      active = false;
    }
  };
}
