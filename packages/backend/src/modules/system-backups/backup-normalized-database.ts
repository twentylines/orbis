import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { BackupRequirementError } from './backup-files';
import { BackupDatabaseLines } from './backup-docker-exec';
import { BackupDatabaseRecords, backupDatabaseLimits, backupDatabaseTables, type BackupDatabaseTable } from './backup-database-records';
import type { BackupDatabaseReview } from './backup-database.service';

export const invalidRestoreDatabase = () =>
  new BackupRequirementError('The restore database could not be prepared. Your current server data has not been replaced.');

export type NormalizedBackupDatabase = {
  file: string;
  expected: BackupDatabaseReview;
  jwtSecret: string;
  passkeys?: unknown;
};

export async function readNormalizedBackupDatabase(
  source: NormalizedBackupDatabase,
  signal: AbortSignal,
  accept: (table: BackupDatabaseTable, row: Record<string, unknown>) => Promise<void> = async () => undefined,
) {
  signal.throwIfAborted();
  const expected = source.expected;
  if (
    !expected ||
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 1 ||
    expected.bytes > backupDatabaseLimits.totalBytes ||
    !expected.counts ||
    Object.keys(expected.counts).length !== backupDatabaseTables.length ||
    backupDatabaseTables.some(
      (table) => !Number.isSafeInteger(expected.counts[table]) || expected.counts[table] < 0 || expected.counts[table] > backupDatabaseLimits.rows,
    )
  )
    throw invalidRestoreDatabase();
  const file = await fs.open(source.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const digest = createHash('sha256');
  const validator = new BackupDatabaseRecords(source.jwtSecret);
  let order = -1;
  let bytes = 0;
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (await fs.realpath(source.file)) !== source.file ||
      before.size !== expected.bytes ||
      before.mode & 0o077 ||
      (process.getuid && before.uid !== process.getuid())
    )
      throw invalidRestoreDatabase();
    const lines = new BackupDatabaseLines({ ...backupDatabaseLimits, rowBytes: backupDatabaseLimits.rowBytes + 512 }, async (value) => {
      signal.throwIfAborted();
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 2 ||
        !Object.hasOwn(value, 'table') ||
        !Object.hasOwn(value, 'row')
      )
        throw invalidRestoreDatabase();
      const item = value as { table: unknown; row: unknown };
      if (typeof item.table !== 'string' || !backupDatabaseTables.includes(item.table as BackupDatabaseTable)) throw invalidRestoreDatabase();
      const table = item.table as BackupDatabaseTable;
      const index = backupDatabaseTables.indexOf(table);
      if (index < order) throw invalidRestoreDatabase();
      order = index;
      const row = validator.accept(table, item.row);
      await accept(table, row);
    });
    const stream = file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
    const abort = () => stream.destroy(new Error('Restore cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    let after: Awaited<ReturnType<typeof file.stat>>;
    try {
      signal.throwIfAborted();
      for await (const raw of stream) {
        signal.throwIfAborted();
        const chunk = Buffer.from(raw);
        bytes += chunk.length;
        if (bytes > expected.bytes) throw invalidRestoreDatabase();
        digest.update(chunk);
        await lines.write(chunk);
      }
      lines.finish();
      after = await file.stat();
    } finally {
      signal.removeEventListener('abort', abort);
      stream.destroy();
    }
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes !== expected.bytes ||
      digest.digest('hex') !== expected.sha256
    )
      throw invalidRestoreDatabase();
    const counts = await validator.finish(source.passkeys, signal);
    if (backupDatabaseTables.some((table) => counts[table] !== expected.counts[table])) throw invalidRestoreDatabase();
    return { counts, bytes };
  } finally {
    await file.close();
  }
}
