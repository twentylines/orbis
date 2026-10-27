import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BackupRequirementError, privateBackupDirectory } from './backup-files';

export async function acquireRestoreLease(store: string): Promise<() => void> {
  await privateBackupDirectory(store);
  const file = path.join(store, 'lease.sqlite');
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await fs.lstat(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.mode & 0o077 ||
    stat.size > 64 * 1024 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new BackupRequirementError('Restore storage needs review. No data has been changed.');
  const database = new DatabaseSync(file);
  let locked = false;
  try {
    // SQLite releases this process-shared lock on exit, including an abrupt worker crash.
    database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    locked = true;
    const mode = database.prepare('PRAGMA journal_mode').get() as { journal_mode?: string };
    if (mode.journal_mode !== 'delete') throw new Error('Unexpected restore lock format');
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if (tables.some((row) => row.name !== 'restore_lock')) throw new Error('Unexpected restore lock tables');
    database.exec(
      'CREATE TABLE IF NOT EXISTS restore_lock(version INTEGER PRIMARY KEY CHECK(version=1)); INSERT OR IGNORE INTO restore_lock VALUES(1)',
    );
    const version = database.prepare('SELECT version FROM restore_lock').all();
    if (version.length !== 1 || version[0]?.version !== 1) throw new Error('Unexpected restore lock version');
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        database.exec('ROLLBACK');
      } finally {
        database.close();
      }
    };
  } catch (error) {
    try {
      if (locked) database.exec('ROLLBACK');
    } finally {
      database.close();
    }
    throw error;
  }
}

export async function withRestoreLease<T>(store: string, operation: () => Promise<T>): Promise<T> {
  const release = await acquireRestoreLease(store);
  try {
    return await operation();
  } finally {
    release();
  }
}
