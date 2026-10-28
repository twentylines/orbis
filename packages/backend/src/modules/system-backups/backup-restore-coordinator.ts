import { BackupDirectorySwap } from './backup-directory-swap';
import { BackupRequirementError } from './backup-files';
import { BackupRestoreJournal } from './backup-restore-journal';
import { withRestoreLease } from './backup-restore-lease';
import path from 'node:path';

// Runtime operations must be idempotent and verify their recorded Docker/database ownership.
export type RestoreRuntime = {
  stopWriters: (signal: AbortSignal) => Promise<void>;
  installDatabasePointer: (signal: AbortSignal) => Promise<void>;
  verify: (signal: AbortSignal) => Promise<void>;
  activate: () => Promise<void>;
  restoreDatabasePointer: () => Promise<void>;
  resumeOriginal: () => Promise<void>;
};
const active = new Set<string>();
const recoveryError = () => new BackupRequirementError('Restore recovery is incomplete. Apps remain stopped to protect their data.');

export class RestoreRolledBackError extends BackupRequirementError {
  constructor(
    readonly cancelled: boolean,
    cause: unknown,
  ) {
    super('The restore did not complete. Your original server has been recovered.', { cause });
  }
}

export async function runRestoreTransaction(journal: BackupRestoreJournal, runtime: RestoreRuntime, signal: AbortSignal) {
  if (active.has(journal.directory)) throw recoveryError();
  active.add(journal.directory);
  try {
    return await withRestoreLease(path.dirname(journal.directory), async () => {
      await journal.refresh();
      if (['staging', 'preparing', 'discarded'].includes(journal.state.phase))
        throw new BackupRequirementError('The restore is not prepared. Server data has not been changed.');
      await journal.verifyRootLocations();
      const roots = await Promise.all(journal.state.roots.map((name) => BackupDirectorySwap.open(journal.rootJournal(name))));
      const recover = async () => {
        await journal.advance('rolling-back');
        // Cancellation of the requested restore must not cancel its recovery.
        await runtime.stopWriters(new AbortController().signal);
        await runtime.restoreDatabasePointer();
        for (const root of [...roots].reverse()) await root.rollback();
        // Allow only the recorded original controller to pass the pre-env startup guard.
        await journal.advance('rolled-back');
        await runtime.resumeOriginal();
      };
      const finish = async () => {
        for (const root of roots) await root.commit();
        await runtime.activate();
        await journal.advance('completed');
      };
      if (journal.state.phase === 'completed') return 'completed' as const;
      if (journal.state.phase === 'rolled-back') {
        await runtime.resumeOriginal();
        return 'rolled-back' as const;
      }
      if (journal.state.decision === 'commit') {
        await finish();
        return 'completed' as const;
      }
      if (journal.state.phase !== 'prepared') {
        await recover();
        return 'rolled-back' as const;
      }
      try {
        signal.throwIfAborted();
        await journal.advance('quiescing');
        await runtime.stopWriters(signal);
        signal.throwIfAborted();
        await journal.advance('promoting');
        for (const root of roots) await root.promote(signal);
        await runtime.installDatabasePointer(signal);
        await journal.advance('verifying');
        await runtime.verify(signal);
        signal.throwIfAborted();
        // This durable global decision precedes every irreversible per-root commit.
        await journal.advance('committing');
      } catch (error) {
        // A rename can succeed before the directory fsync fails. Read the durable decision
        // before choosing rollback; an uncertain commit must never be reversed from stale memory.
        const current = await journal.refresh();
        if (current.decision === 'commit') throw recoveryError();
        try {
          await recover();
        } catch {
          throw recoveryError();
        }
        throw new RestoreRolledBackError(signal.aborted, error);
      }
      await finish();
      return 'completed' as const;
    });
  } finally {
    active.delete(journal.directory);
  }
}
