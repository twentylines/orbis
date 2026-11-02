import path from 'node:path';
import { BackupDirectorySwap } from './backup-directory-swap';
import { BackupRequirementError } from './backup-files';
import { BackupRestoreJournal } from './backup-restore-journal';
import { withRestoreLease } from './backup-restore-lease';

export type RetainedPhase = 'prepare' | 'promote' | 'verify' | 'rollback' | 'commit';
export type RetainedRootDecision = 'none' | 'rollback' | 'commit';
export type RetainedPhaseAuthority = {
  restoreId: string;
  nonce: string;
  phase: RetainedPhase;
  decision: RetainedRootDecision;
  commitStage: 'authorize' | 'finish' | null;
  // Must recheck the root-owned decision and capability, including after asynchronous work.
  verify: () => Promise<void>;
};
export type RetainedPhaseRuntime = {
  prepare: (signal: AbortSignal) => Promise<void>;
  discardPreparation: (signal: AbortSignal) => Promise<void>;
  stopWriters: (signal: AbortSignal) => Promise<void>;
  installDatabasePointer: (signal: AbortSignal) => Promise<void>;
  verifyCandidate: (signal: AbortSignal) => Promise<void>;
  restoreDatabasePointer: () => Promise<void>;
  resumeOriginal: () => Promise<void>;
  confirmRootActivation: () => Promise<void>;
};
const fail = () => new BackupRequirementError('Retained restore needs protected host recovery. Keep the server in maintenance.');
const active = new Set<string>();

// This core is not a public driver: a root-authenticated caller must supply a bound capability.
export async function runRetainedRestorePhase(options: {
  journal: BackupRestoreJournal;
  phase: RetainedPhase;
  authority: RetainedPhaseAuthority;
  runtime: RetainedPhaseRuntime;
  signal: AbortSignal;
}) {
  const { journal, phase, authority, runtime, signal } = options;
  if (active.has(journal.directory)) throw fail();
  active.add(journal.directory);
  try {
    return await withRestoreLease(path.dirname(journal.directory), async () => {
      const state = await journal.refresh();
      const expectedDecision: RetainedRootDecision = phase === 'commit' ? 'commit' : phase === 'rollback' ? 'rollback' : 'none';
      if (
        authority.restoreId !== state.id ||
        authority.nonce !== state.nonce ||
        authority.phase !== phase ||
        authority.decision !== expectedDecision ||
        (phase === 'commit' ? !['authorize', 'finish'].includes(authority.commitStage ?? '') : authority.commitStage !== null)
      )
        throw fail();
      await authority.verify();
      signal.throwIfAborted();
      if (phase === 'prepare') {
        if (state.phase === 'prepared') return 'prepared' as const;
        if (state.phase !== 'staging' || state.decision !== null) throw fail();
        await runtime.prepare(signal);
        await authority.verify();
        if ((await journal.refresh()).phase !== 'prepared') throw fail();
        return 'prepared' as const;
      }
      if (phase === 'rollback' && ['staging', 'preparing', 'discarded'].includes(state.phase)) {
        if (state.phase !== 'discarded') await runtime.discardPreparation(signal);
        await authority.verify();
        if ((await journal.refresh()).phase !== 'discarded') throw fail();
        return 'rolled-back' as const;
      }
      await journal.verifyRootLocations();
      const roots = await Promise.all(state.roots.map((name) => BackupDirectorySwap.open(journal.rootJournal(name))));
      if (phase === 'promote') {
        if (state.phase === 'verifying' && state.decision === null) return 'promoted' as const;
        // Partial renames are not safely replayable. Root must authorize rollback instead.
        if (state.phase !== 'prepared' || state.decision !== null) throw fail();
        await journal.advance('quiescing');
        await runtime.stopWriters(signal);
        await authority.verify();
        signal.throwIfAborted();
        await journal.advance('promoting');
        for (const root of roots) await root.promote(signal);
        await runtime.installDatabasePointer(signal);
        await authority.verify();
        await journal.advance('verifying');
        return 'promoted' as const;
      }
      if (phase === 'verify') {
        if (state.phase !== 'verifying' || state.decision !== null) throw fail();
        await runtime.verifyCandidate(signal);
        await authority.verify();
        return 'verified' as const;
      }
      if (phase === 'rollback') {
        if (state.decision === 'commit' || ['committing', 'completed'].includes(state.phase)) throw fail();
        if (state.phase === 'rolled-back') {
          await runtime.resumeOriginal();
          return 'rolled-back' as const;
        }
        if (!['prepared', 'quiescing', 'promoting', 'verifying', 'rolling-back'].includes(state.phase)) throw fail();
        await journal.advance('rolling-back');
        // Cancellation must not interrupt a root-authorized recovery.
        await runtime.stopWriters(new AbortController().signal);
        await runtime.restoreDatabasePointer();
        for (const root of [...roots].reverse()) await root.rollback();
        await authority.verify();
        await journal.advance('rolled-back');
        await runtime.resumeOriginal();
        return 'rolled-back' as const;
      }
      if (state.phase === 'completed' && state.decision === 'commit' && authority.commitStage === 'finish') return 'completed' as const;
      if (authority.commitStage === 'authorize') {
        if (state.phase === 'committing' && state.decision === 'commit') return 'authorized' as const;
        if (state.phase !== 'verifying' || state.decision !== null) throw fail();
        await authority.verify();
        await journal.advance('committing');
        return 'authorized' as const;
      }
      if (authority.commitStage !== 'finish' || state.phase !== 'committing' || state.decision !== 'commit') throw fail();
      await runtime.confirmRootActivation();
      await authority.verify();
      for (const root of roots) await root.commitAfterActivation();
      await runtime.confirmRootActivation();
      await authority.verify();
      await journal.advance('completed');
      return 'completed' as const;
    });
  } finally {
    active.delete(journal.directory);
  }
}
