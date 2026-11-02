import 'reflect-metadata';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import Dockerode from 'dockerode';
import { DATA_DIR } from './common/constants';
import { BackupRestoreJournal } from './modules/system-backups/backup-restore-journal';
import { RestoreRolledBackError } from './modules/system-backups/backup-restore-coordinator';
import { executeRestoreWorker, type RestoreWorkerProgress } from './modules/system-backups/backup-restore-worker';
import { requestRestoreCancellation } from './modules/system-backups/backup-restore-bootstrap';
import { restoreFailureProgress } from './modules/system-backups/backup-restore-diagnostics';
import { parseRestoreWorkerArguments } from './modules/system-backups/backup-restore-worker-arguments';
const retainedArguments = process.argv.slice(2);
if (retainedArguments.length === 3 && retainedArguments[1] === '--retained-phase') {
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  try {
    const { readRetainedPhaseInput, runRetainedPhaseDriver } = await import('./modules/system-backups/time-machine-retained-driver');
    const id = retainedArguments[0] ?? '';
    const input = await readRetainedPhaseInput(
      process.stdin,
      id,
      retainedArguments[2] ?? '',
      AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
    );
    await runRetainedPhaseDriver({ id, ...input, signal: abort.signal });
  } catch {
    process.stderr.write('Protected retained restore phase failed.\n');
    process.exitCode = 1;
  }
} else {
  const abort = new AbortController();
  process.once('SIGINT', () => {
    void (journal ? requestRestoreCancellation(journal) : Promise.resolve()).catch(() => undefined).finally(() => abort.abort());
  });
  process.once('SIGTERM', () => abort.abort());
  let journal: BackupRestoreJournal | undefined;
  let worker: string | undefined;
  let settled = false;
  let stage = 'reading-job';
  const docker = new Dockerode();
  let preparation: RestoreWorkerProgress['preparation'];
  let pendingProgress: Promise<void> | undefined;
  let progressChanged = false;
  async function report(status: string, message: string, check?: string) {
    if (!journal) return;
    const value = {
      status,
      stage,
      message,
      ...(preparation ? { preparation: structuredClone(preparation) } : {}),
      ...(check ? { check } : {}),
      updatedAt: Date.now(),
    };
    const file = path.join(journal.directory, 'worker-status.json');
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(value));
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
  let progressMessage = '';
  const timer = setInterval(() => {
    if (!progressChanged || pendingProgress) return;
    progressChanged = false;
    pendingProgress = report('running', progressMessage)
      .catch(() => undefined)
      .finally(() => {
        pendingProgress = undefined;
      });
  }, 300);
  timer.unref();
  async function finishProgress() {
    clearInterval(timer);
    await pendingProgress;
    progressChanged = false;
  }
  try {
    const id = parseRestoreWorkerArguments(process.argv.slice(2));
    const active = await BackupRestoreJournal.active(path.join(DATA_DIR, 'backups', 'restores'));
    if (!active || active.state.id !== id) throw new Error('Restore not found');
    journal = active;
    const result = await executeRestoreWorker({
      docker,
      journal,
      hostname: os.hostname(),
      signal: abort.signal,
      onVerified: (id) => {
        worker = id;
      },
      progress: (value) => {
        stage = value.stage;
        preparation = value.preparation;
        progressMessage = value.message;
        progressChanged = true;
      },
    });
    await finishProgress();
    await report(
      result === 'completed' ? 'succeeded' : 'rolled-back',
      result === 'completed' ? 'The restored server is ready.' : 'Your original server has been recovered.',
    );
    settled = true;
  } catch (error) {
    await finishProgress();
    const diagnostic = restoreFailureProgress(error, stage);
    stage = diagnostic.stage;
    if (error instanceof RestoreRolledBackError) {
      await report(
        'rolled-back',
        error.cancelled
          ? 'Restore cancelled. Your original server is ready.'
          : 'The restore could not finish. Your original server has been recovered.',
        diagnostic.check,
      );
      settled = true;
    } else {
      await report(
        'recovery-required',
        'Restore recovery needs attention. Your original files and database have been preserved.',
        diagnostic.check,
      ).catch(() => undefined);
      process.exitCode = 1;
    }
  } finally {
    clearInterval(timer);
    if (worker && journal) {
      const current = await journal.refresh().catch(() => undefined);
      if (settled && current && ['completed', 'rolled-back', 'discarded'].includes(current.phase))
        await docker
          .getContainer(worker)
          .update({ RestartPolicy: { Name: 'no', MaximumRetryCount: 0 } })
          .catch(() => undefined);
    }
  }
}
