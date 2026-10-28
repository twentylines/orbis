import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type Dockerode from 'dockerode';
import { BackupRequirementError } from './backup-files';
import { readRestoreBootstrap, restoreCancellationRequested } from './backup-restore-bootstrap';
import { RestoreRolledBackError, runRestoreTransaction } from './backup-restore-coordinator';
import { BackupRestoreJournal } from './backup-restore-journal';
import { withRestoreLease } from './backup-restore-lease';
import { discardRestorePayload, prepareRestorePayload, type RestorePreparationProgress } from './backup-restore-preparation';
import { restoreTreeNames, type RestoreTreeName } from './backup-restore-materialize';
import { BackupRestoreDockerRuntime, readRestoreOperation } from './backup-restore-runtime';

export type RestoreWorkerProgress = { stage: string; message: string; preparation?: RestorePreparationProgress };
const failed = () => new BackupRequirementError('Restore recovery needs attention. Keep apps stopped until recovery completes.');

async function environmentDigest(file: string) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.mode & 0o077 ||
      before.size > 1024 * 1024 ||
      (process.getuid && before.uid !== process.getuid())
    )
      throw failed();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.size !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw failed();
    return createHash('sha256').update(bytes).digest('hex');
  } finally {
    await handle.close();
  }
}

export async function executeRestoreWorker(options: {
  docker: Dockerode;
  journal: BackupRestoreJournal;
  hostname: string;
  signal: AbortSignal;
  progress: (value: RestoreWorkerProgress) => void;
  onVerified?: (worker: string) => void;
  directories?: { data: string; appData: string; cache: string; migrations: string };
}) {
  const { docker, journal, hostname, progress } = options;
  const cancelled = new AbortController();
  const signal = AbortSignal.any([options.signal, cancelled.signal]);
  let checking: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (checking) return;
    checking = restoreCancellationRequested(journal)
      .then((requested) => {
        if (requested) cancelled.abort();
      })
      .catch(() => {
        cancelled.abort();
      })
      .finally(() => {
        checking = undefined;
      });
  }, 250);
  timer.unref();
  try {
    const directories = options.directories ?? { data: '/data', appData: '/app-data', cache: '/cache', migrations: '/app/assets/migrations' };
    const state = await journal.refresh();
    if (['staging', 'preparing', 'discarded'].includes(state.phase)) {
      const bootstrap = await readRestoreBootstrap(journal);
      const runtime = new BackupRestoreDockerRuntime(docker, journal, bootstrap.identity, directories);
      const verifiedWorker = await runtime.verifyWorker(hostname, { preparing: true });
      options.onVerified?.(verifiedWorker);
      const result = await withRestoreLease(path.dirname(journal.directory), async () => {
        const current = await journal.refresh();
        const recover = async () => {
          progress({ stage: 'recovering', message: 'Recovering your original server.' });
          // Recovery remains active after the requested restore has been cancelled.
          await runtime.stopWriters(new AbortController().signal);
          await discardRestorePayload({ journal, connection: bootstrap.connection, signal: new AbortController().signal });
          await runtime.resumeOriginal();
        };
        if (['preparing', 'discarded'].includes(current.phase)) {
          await recover();
          return 'rolled-back' as const;
        }
        if (current.phase !== 'staging') throw failed();
        // This fsynced phase closes ordinary controller startup before any writer is stopped.
        await journal.advance('preparing');
        try {
          if (await restoreCancellationRequested(journal)) cancelled.abort();
          signal.throwIfAborted();
          if ((await environmentDigest(path.join(directories.data, '.env'))) !== bootstrap.environmentSha256) throw failed();
          progress({ stage: 'quiescing', message: 'Stopping apps while their data is restored.' });
          await runtime.stopWriters(signal);
          const roots = Object.fromEntries(
            restoreTreeNames.map((name) => [name, name === 'app-data' ? directories.appData : path.join(directories.data, name)]),
          ) as Record<RestoreTreeName, string>;
          await prepareRestorePayload({
            journal,
            source: { directory: path.join(journal.directory, 'source', 'payload'), seal: bootstrap.source },
            roots,
            environment: path.join(directories.data, '.env'),
            trustedMigrationsFolder: directories.migrations,
            runtime: { ...bootstrap.identity, connection: bootstrap.connection },
            signal,
            progress: (preparation) => progress({ stage: preparation.stage, message: 'Preparing configuration and app data.', preparation }),
          });
        } catch (error) {
          // A completed durable preparation belongs to the transaction coordinator, even if its final progress callback failed.
          const after = await journal.refresh();
          if (after.phase === 'prepared') throw error;
          try {
            await recover();
          } catch {
            throw failed();
          }
          throw new RestoreRolledBackError(signal.aborted, error);
        }
        return 'prepared' as const;
      });
      if (result === 'rolled-back') return result;
    }
    const operation = await readRestoreOperation(journal);
    const runtime = new BackupRestoreDockerRuntime(docker, journal, operation, directories);
    const verifiedWorker = await runtime.verifyWorker(hostname);
    options.onVerified?.(verifiedWorker);
    if (await restoreCancellationRequested(journal)) cancelled.abort();
    progress({ stage: 'restoring', message: 'Restoring server configuration and app data.' });
    return await runRestoreTransaction(journal, runtime, signal);
  } finally {
    clearInterval(timer);
    await checking;
  }
}
