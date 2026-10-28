import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type } from 'arktype';
import { BackupRequirementError, privateBackupDirectory } from './backup-files';
import { BackupRestoreJournal } from './backup-restore-journal';
import { restoreDatabaseConnectionSchema, restoreRuntimeIdentitySchema, validateRestoreIdentity } from './backup-restore-runtime';
import { backupSourceSealSchema } from './backup-restore-source';

const schema = type({
  '+': 'reject',
  version: '1',
  ownerId: 'number.integer > 0',
  identity: restoreRuntimeIdentitySchema,
  connection: restoreDatabaseConnectionSchema,
  source: backupSourceSealSchema,
  environmentSha256: type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value)),
});
export type RestoreBootstrap = typeof schema.infer;
const failed = () => new BackupRequirementError('The restore handoff could not be verified. Your server data has been preserved.');
async function syncDirectory(journal: BackupRestoreJournal) {
  const directory = await fs.open(journal.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function validate(journal: BackupRestoreJournal, input: unknown) {
  const value = schema(input);
  if (value instanceof type.errors || !value.identity.worker || value.identity.original.id !== value.identity.candidate.id) throw failed();
  await validateRestoreIdentity(journal, value.identity);
  return value;
}

async function readPrivate(journal: BackupRestoreJournal, name: string) {
  await privateBackupDirectory(journal.directory);
  const file = await fs.open(path.join(journal.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > 1024 * 1024 || (process.getuid && stat.uid !== process.getuid()))
      throw failed();
    return JSON.parse(await file.readFile('utf8')) as unknown;
  } finally {
    await file.close();
  }
}

export async function readRestoreBootstrap(journal: BackupRestoreJournal) {
  return validate(journal, await readPrivate(journal, 'bootstrap.json'));
}

async function createPrivate(journal: BackupRestoreJournal, name: string, value: unknown) {
  await privateBackupDirectory(journal.directory);
  const temporary = path.join(journal.directory, `.${randomUUID()}.bootstrap`);
  try {
    const file = await fs.open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.link(temporary, path.join(journal.directory, name));
    await fs.rm(temporary);
    await syncDirectory(journal);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function writeRestoreBootstrap(journal: BackupRestoreJournal, input: RestoreBootstrap) {
  if ((await journal.refresh()).phase !== 'staging') throw failed();
  await createPrivate(journal, 'bootstrap.json', await validate(journal, input));
  return readRestoreBootstrap(journal);
}

export async function restoreCancellationRequested(journal: BackupRestoreJournal) {
  let value: unknown;
  try {
    value = await readPrivate(journal, 'cancel.json');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const state = await journal.refresh();
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !('version' in value) ||
    value.version !== 1 ||
    !('id' in value) ||
    value.id !== state.id ||
    !('nonce' in value) ||
    value.nonce !== state.nonce
  )
    throw failed();
  return true;
}

export async function requestRestoreCancellation(journal: BackupRestoreJournal) {
  const state = await journal.refresh();
  if (state.decision === 'commit' || ['completed', 'rolled-back', 'discarded'].includes(state.phase))
    throw new BackupRequirementError('This restore is finishing or already settled. It can no longer be cancelled.');
  if (await restoreCancellationRequested(journal)) {
    await syncDirectory(journal);
    return;
  }
  try {
    await createPrivate(journal, 'cancel.json', { version: 1, id: state.id, nonce: state.nonce });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await restoreCancellationRequested(journal))) throw error;
  }
  await syncDirectory(journal);
}
