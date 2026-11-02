import path from 'node:path';
import os from 'node:os';
import Dockerode from 'dockerode';
import { finalizeTerminalRestoreBeforeStartup } from './backup-restore-terminal-cleanup';
import { terminalFailure, terminalPhase } from './backup-restore-terminal-record';
import { setTimeout as delay } from 'node:timers/promises';
import { BackupRestoreJournal, restoreControllerRetired, restoreStartupAllowed } from './backup-restore-journal';
import { readRootRestorationState } from '@/common/restoration-root-status';
import { retainedNormalBootstrapCapability, RetainedRootTransaction } from './time-machine-retained-root-client';
import { readTerminalJson } from './backup-restore-terminal-record';
import { canonicalPublicationJson } from '@/modules/host-updates/host-controller-publication';
import { setRestoreRecoveryRequired } from '@/common/backup-maintenance';

let startupRole: 'ordinary' | 'verify' | 'candidate' = 'ordinary';
let retainedBootstrap = false;
let retainedSettled = false;
export const retainedSettledStartup = () => retainedSettled;
export const retainedBootstrapStartup = () => retainedBootstrap;
export const setRetainedBootstrapStartup = (value: boolean) => {
  retainedBootstrap = value;
};
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
    const maintenance = !journal && self ? await readRootRestorationState() : null;
    if (!journal && self && maintenance === 'idle' && process.env.ORBIS_HOST_SOCKET === '/run/orbis/host.sock') {
      const latest = await BackupRestoreJournal.latest(store).catch(() => undefined);
      if (
        latest?.state.phase === 'completed' &&
        latest.state.decision === 'commit' &&
        latest.state.candidateController.startsWith(options.controller)
      ) {
        const signal = options.signal ?? AbortSignal.timeout(30_000);
        try {
          if (await retainedNormalBootstrapCapability(signal)) {
            const transaction = await RetainedRootTransaction.read(latest.directory);
            const proof = await transaction.terminalProof(signal);
            const status = await transaction.normalBootstrapStatus(proof.proofSha256, signal);
            if (
              proof.state !== 'complete' ||
              proof.decision !== 'commit' ||
              proof.nodePhase !== 'completed' ||
              proof.binding?.nonce !== latest.state.nonce ||
              proof.binding.candidateController !== latest.state.candidateController ||
              proof.survivor.id !== latest.state.candidateController ||
              !status.required ||
              status.state !== 'ready'
            )
              throw terminalFailure();
            retainedSettled = true;
          }
        } catch {
          // Root is idle and no restore is active: use the non-destructive continuation without treating history as authority.
          retainedSettled = true;
        }
      }
    }
    if (!journal && self && maintenance === 'checking') {
      const latest = await BackupRestoreJournal.latest(store);
      if (!latest) throw terminalFailure();
      if (latest.state.phase === 'completed' && latest.state.decision === 'commit') {
        const transaction = await RetainedRootTransaction.read(latest.directory);
        const signal = options.signal ?? AbortSignal.timeout(30_000);
        const proof = await transaction.terminalProof(signal);
        const status = await transaction.normalBootstrapStatus(proof.proofSha256, signal);
        if (status.required) {
          const receipt = await readTerminalJson(path.join(latest.directory, 'retained-terminal-reconciliation.json'));
          const expected = {
            version: 1,
            transactionId: latest.state.id,
            pointId: proof.pointId,
            proofSha256: proof.proofSha256,
            nodeJournalSha256: proof.nodeJournalSha256,
            operationSha256: proof.operationSha256,
            decision: proof.decision,
            survivorId: proof.survivor.id,
            databaseOid: proof.database.oid,
          };
          if (
            proof.state !== 'complete' ||
            proof.decision !== 'commit' ||
            proof.nodePhase !== 'completed' ||
            proof.transactionId !== latest.state.id ||
            proof.binding?.nonce !== latest.state.nonce ||
            proof.binding.candidateController !== latest.state.candidateController ||
            proof.survivor.id !== latest.state.candidateController ||
            !proof.survivor.id.startsWith(options.controller) ||
            canonicalPublicationJson(receipt) !== canonicalPublicationJson(expected)
          )
            throw terminalFailure();
          setRestoreRecoveryRequired(true);
          retainedBootstrap = true;
          return 'candidate';
        }
      }
    }
    if (
      journal?.state.phase === 'committing' &&
      journal.state.candidateController.startsWith(options.controller) &&
      process.env.ORBIS_HOST_SOCKET === '/run/orbis/host.sock' &&
      (await retainedNormalBootstrapCapability(options.signal ?? AbortSignal.timeout(30_000)))
    ) {
      setRestoreRecoveryRequired(true);
      retainedBootstrap = true;
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
