import path from 'node:path';
import os from 'node:os';
import Dockerode from 'dockerode';
import { finalizeTerminalRestoreBeforeStartup } from './backup-restore-terminal-cleanup';
import { terminalFailure, terminalPhase } from './backup-restore-terminal-record';
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
    const self = options.controller === os.hostname() && /^[a-f0-9]{12,64}$/.test(options.controller);
    if (self && retired) throw terminalFailure();
    if (self && journal && terminalPhase(journal.state) && !restoreStartupAllowed(journal.state, options.controller, options.installation)) {
      if (options.installation?.phase !== 'normal' || options.installation.transactionId !== null) throw terminalFailure();
      await finalizeTerminalRestoreBeforeStartup({
        docker: new Dockerode({ socketPath: '/var/run/docker.sock' }),
        store,
        controller: options.controller,
        data: options.dataDirectory,
        signal: options.signal ?? new AbortController().signal,
      });
      return 'ordinary';
    }
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
