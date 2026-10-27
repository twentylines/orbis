import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BackupRestoreJournal, restoreControllerRetired, restoreStartupAllowed } from './backup-restore-journal';

let startupRole: 'ordinary' | 'verify' | 'candidate' = 'ordinary';
export const restoreStartupRole = () => startupRole;
export const captureRestoreStartupRole = (role: typeof startupRole) => {
  startupRole = role;
};

export async function waitForRestoreStartup(options: {
  dataDirectory: string;
  controller: string;
  installation?: { phase: string; transactionId: string | null };
  signal?: AbortSignal;
  onHeld: () => void;
}) {
  const store = path.join(options.dataDirectory, 'backups', 'restores');
  let notified = false;
  while (true) {
    options.signal?.throwIfAborted();
    const retired = await restoreControllerRetired(store, options.controller);
    const journal = await BackupRestoreJournal.active(store);
    if (!retired && (!journal || restoreStartupAllowed(journal.state, options.controller, options.installation)))
      return journal?.state.phase === 'verifying' && journal.state.verifierController?.startsWith(options.controller)
        ? 'verify'
        : journal?.state.phase === 'committing' && journal.state.candidateController.startsWith(options.controller)
          ? 'candidate'
          : 'ordinary';
    if (!notified) {
      options.onHeld();
      notified = true;
    }
    await delay(1000, undefined, { signal: options.signal });
  }
}
