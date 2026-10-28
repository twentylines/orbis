import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type } from 'arktype';
import { BackupRequirementError } from './backup-files';
import type { BackupRestoreJournal } from './backup-restore-journal';

const count = 'number.integer >= 0 & number <= 9007199254740991' as const;
const saved = type({
  '+': 'reject',
  status: "'running' | 'succeeded' | 'rolled-back' | 'recovery-required'",
  stage: "'reading-job' | 'recovering' | 'quiescing' | 'checking' | 'files' | 'database' | 'sealing' | 'prepared' | 'restoring'",
  message: 'string <= 512',
  updatedAt: 'number.integer > 0',
  'check?': type('string').narrow((value) => /^[a-z-]{1,40}$/.test(value)),
  'preparation?': type({
    '+': 'reject',
    stage: "'checking' | 'files' | 'database' | 'sealing' | 'prepared'",
    completedBytes: count,
    totalBytes: type(count).or('null'),
    records: count,
    totalRecords: type(count).or('null'),
  }),
});

export async function readRestoreProgress(journal: BackupRestoreJournal) {
  let file: Awaited<ReturnType<typeof fs.open>>;
  try {
    file = await fs.open(path.join(journal.directory, 'worker-status.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 16 * 1024 || (process.getuid && stat.uid !== process.getuid()))
      throw new BackupRequirementError('Restore progress could not be verified.');
    const bytes = await file.readFile();
    const after = await file.stat();
    if (bytes.length !== stat.size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs)
      throw new BackupRequirementError('Restore progress could not be verified.');
    const value = saved(JSON.parse(bytes.toString('utf8')));
    if (value instanceof type.errors) throw new BackupRequirementError('Restore progress could not be verified.');
    if (
      value.preparation &&
      ((value.preparation.totalBytes !== null && value.preparation.completedBytes > value.preparation.totalBytes) ||
        (value.preparation.totalRecords !== null && value.preparation.records > value.preparation.totalRecords))
    )
      throw new BackupRequirementError('Restore progress could not be verified.');
    // Messages in the private record never become public output; the API uses its own fixed copy.
    const { message: _message, ...progress } = value;
    return progress;
  } finally {
    await file.close();
  }
}
