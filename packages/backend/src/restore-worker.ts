import 'reflect-metadata';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import Dockerode from 'dockerode';
import { DATA_DIR } from './common/constants';
import { BackupRestoreJournal } from './modules/system-backups/backup-restore-journal';
import { RestoreRolledBackError, runRestoreTransaction } from './modules/system-backups/backup-restore-coordinator';
import { BackupRestoreDockerRuntime, readRestoreOperation } from './modules/system-backups/backup-restore-runtime';

const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
let journal: BackupRestoreJournal | undefined;
let worker: string | undefined;
let settled = false;
let stage = 'reading-job';
const docker = new Dockerode();
async function report(status: string, message: string, check?: string) {
  if (!journal) return;
  const file = path.join(journal.directory, 'worker-status.json');
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ status, stage, message, ...(check ? { check } : {}), updatedAt: Date.now() }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    const parent = await fs.open(journal.directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
try {
  const active = await BackupRestoreJournal.active(path.join(DATA_DIR, 'backups', 'restores'));
  if (!active || active.state.id !== process.argv[2]) throw new Error('Restore not found');
  journal = active;
  stage = 'reading-runtime';
  const operation = await readRestoreOperation(journal);
  const runtime = new BackupRestoreDockerRuntime(docker, journal, operation);
  stage = 'checking-containers';
  worker = await runtime.verifyWorker(os.hostname());
  stage = 'restoring';
  await report('running', 'Restoring server configuration and app data.');
  const result = await runRestoreTransaction(journal, runtime, abort.signal);
  await report(
    result === 'completed' ? 'succeeded' : 'rolled-back',
    result === 'completed' ? 'The restored server is ready.' : 'Your original server has been recovered.',
  );
  settled = true;
} catch (error) {
  if (error instanceof RestoreRolledBackError) {
    await report(
      'rolled-back',
      error.cancelled
        ? 'Restore cancelled. Your original server is ready.'
        : 'The restore could not finish. Your original server has been recovered.',
    );
    settled = true;
  } else {
    const code = error && typeof error === 'object' && 'runtimeCheck' in error ? error.runtimeCheck : undefined;
    await report(
      'recovery-required',
      'Restore recovery needs attention. Your original files and database have been preserved.',
      typeof code === 'string' && /^[a-z-]{1,40}$/.test(code) ? code : undefined,
    ).catch(() => undefined);
    process.exitCode = 1;
  }
} finally {
  if (worker && journal) {
    const current = await journal.refresh().catch(() => undefined);
    if (settled && current && ['completed', 'rolled-back', 'discarded'].includes(current.phase))
      await docker
        .getContainer(worker)
        .update({ RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } })
        .catch(() => undefined);
  }
}
