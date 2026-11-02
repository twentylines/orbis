import type { BackupRestoreJournal } from './backup-restore-journal';
import { RetainedPhaseClient } from './time-machine-retained-phase-client';
import { runRetainedRestorePhase, type RetainedPhase, type RetainedPhaseRuntime } from './time-machine-retained-phases';

// The caller must derive expected identities and target from the authenticated point and journal, never browser input.
// Root holds its transaction lock from redemption through completion; a lost acknowledgement requires root recovery.
export async function runAuthenticatedRetainedPhase(options: {
  client: RetainedPhaseClient;
  journal: BackupRestoreJournal;
  phase: RetainedPhase;
  expected: Parameters<RetainedPhaseClient['redeem']>[1];
  runtime: (status: Awaited<ReturnType<RetainedPhaseClient['phaseStatus']>>) => Promise<RetainedPhaseRuntime>;
  signal: AbortSignal;
}) {
  const state = await options.journal.refresh();
  if (
    state.id !== options.expected.restoreId ||
    state.nonce !== options.expected.nonce ||
    state.worker !== options.expected.workerId ||
    state.originalController !== options.expected.originalController ||
    state.candidateController !== options.expected.candidateController ||
    state.verifierController !== options.expected.verifierController
  )
    throw new Error('Retained restore journal binding changed.');
  const grant = await options.client.redeem(options.phase, options.expected, options.signal);
  const status = await options.client.phaseStatus(options.signal);
  const runtimeSource = await options.runtime(status);
  const runtime: RetainedPhaseRuntime = {
    ...runtimeSource,
    confirmRootActivation: async () => {
      if (grant.rootDecision !== 'commit' || grant.commitStage !== 'finish' || !grant.candidateHealthy)
        throw new Error('Root activation is not confirmed.');
      await runtimeSource.confirmRootActivation();
    },
  };
  const result = await runRetainedRestorePhase({
    journal: options.journal,
    phase: options.phase,
    runtime,
    signal: options.signal,
    authority: {
      restoreId: grant.restoreId,
      nonce: grant.nonce,
      phase: grant.phase,
      decision: grant.rootDecision,
      commitStage: grant.commitStage,
      verify: async () => {
        options.signal.throwIfAborted();
      },
    },
  });
  await options.client.complete(options.signal);
  return result;
}
