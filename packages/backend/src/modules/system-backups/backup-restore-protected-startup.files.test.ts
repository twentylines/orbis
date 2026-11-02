import os from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { waitForRestoreStartup } from './backup-restore-startup';
import { BackupRestoreJournal, restoreStartupAllowed } from './backup-restore-journal';
import { setRestoreRecoveryRequired } from '@/common/backup-maintenance';
import { readRootRestorationState } from '@/common/restoration-root-status';
import { retainedNormalBootstrapCapability, RetainedRootTransaction } from './time-machine-retained-root-client';
import { readTerminalJson } from './backup-restore-terminal-record';

vi.mock('./backup-restore-journal', () => ({
  BackupRestoreJournal: { active: vi.fn(), latest: vi.fn() },
  restoreControllerRetired: vi.fn().mockResolvedValue(false),
  restoreStartupAllowed: vi.fn(),
}));
vi.mock('@/common/backup-maintenance', () => ({ setRestoreRecoveryRequired: vi.fn() }));
vi.mock('@/common/restoration-root-status', () => ({ readRootRestorationState: vi.fn() }));
vi.mock('./time-machine-retained-root-client', () => ({ RetainedRootTransaction: { read: vi.fn() }, retainedNormalBootstrapCapability: vi.fn() }));
vi.mock('./backup-restore-terminal-record', () => ({
  terminalFailure: () => new Error('unsafe restore'),
  terminalPhase: () => false,
  readTerminalJson: vi.fn(),
}));
vi.mock('./backup-restore-terminal-cleanup', () => ({ finalizeTerminalRestoreBeforeStartup: vi.fn() }));
const candidate = 'a'.repeat(64);
const journal = {
  directory: '/private/restore',
  state: { id: 'transaction', nonce: 'nonce', phase: 'completed', decision: 'commit', candidateController: candidate },
};
const proof = {
  transactionId: 'transaction',
  pointId: 'point',
  proofSha256: 'proof',
  nodeJournalSha256: 'journal',
  operationSha256: 'operation',
  state: 'complete',
  decision: 'commit',
  nodePhase: 'completed',
  binding: { nonce: 'nonce', candidateController: candidate },
  survivor: { id: candidate },
  database: { oid: 10 },
};
const receipt = {
  version: 1,
  transactionId: 'transaction',
  pointId: 'point',
  proofSha256: 'proof',
  nodeJournalSha256: 'journal',
  operationSha256: 'operation',
  decision: 'commit',
  survivorId: candidate,
  databaseOid: 10,
};
const status = vi.fn();
const terminalProof = vi.fn();
const run = () => waitForRestoreStartup({ dataDirectory: '/data', controller: candidate.slice(0, 12), onHeld: vi.fn() });
beforeEach(() => {
  vi.spyOn(os, 'hostname').mockReturnValue(candidate.slice(0, 12));
  vi.mocked(BackupRestoreJournal.active).mockResolvedValue(undefined);
  vi.mocked(BackupRestoreJournal.latest).mockResolvedValue(journal as never);
  vi.mocked(readRootRestorationState).mockResolvedValue('checking');
  terminalProof.mockResolvedValue(proof);
  status.mockResolvedValue({ required: true, state: 'pending', bootstrapLeaseId: null });
  vi.mocked(RetainedRootTransaction.read).mockResolvedValue({ terminalProof, normalBootstrapStatus: status } as never);
  vi.mocked(readTerminalJson).mockResolvedValue(receipt);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it.each(['pending', 'ready'])('resumes a protected %s terminal only while root is checking', async (state) => {
  status.mockResolvedValue({ required: true, state, bootstrapLeaseId: state === 'ready' ? 'lease' : null });
  expect(await run()).toBe('candidate');
});
it('allows a later ordinary startup without consulting an expired lease when root is idle', async () => {
  vi.stubEnv('ORBIS_HOST_SOCKET', '/run/orbis/host.sock');
  vi.mocked(readRootRestorationState).mockResolvedValue('idle');
  const laterController = 'b'.repeat(12);
  vi.mocked(os.hostname).mockReturnValue(laterController);
  expect(await waitForRestoreStartup({ dataDirectory: '/data', controller: laterController, onHeld: vi.fn() })).toBe('ordinary');
  expect(BackupRestoreJournal.latest).toHaveBeenCalledOnce();
  expect(RetainedRootTransaction.read).not.toHaveBeenCalled();
});
it('rejects a changed reconciliation receipt', async () => {
  vi.mocked(readTerminalJson).mockResolvedValue({ ...receipt, operationSha256: 'changed' });
  await expect(run()).rejects.toThrow('unsafe restore');
});
it('holds startup when root is checking but the terminal journal is missing', async () => {
  vi.mocked(BackupRestoreJournal.latest).mockResolvedValue(undefined);
  await expect(run()).rejects.toThrow('unsafe restore');
});

it('holds the first candidate before any ordinary startup when protected capability requires it', async () => {
  vi.stubEnv('ORBIS_HOST_SOCKET', '/run/orbis/host.sock');
  vi.mocked(BackupRestoreJournal.active).mockResolvedValue({ ...journal, state: { ...journal.state, phase: 'committing' } } as never);
  vi.mocked(restoreStartupAllowed).mockReturnValue(true);
  vi.mocked(retainedNormalBootstrapCapability).mockResolvedValue(true);
  expect(await run()).toBe('candidate');
  expect(setRestoreRecoveryRequired).toHaveBeenCalledExactlyOnceWith(true);
});
it('uses the settled scoped startup on the same restored controller without replaying an old lease', async () => {
  vi.stubEnv('ORBIS_HOST_SOCKET', '/run/orbis/host.sock');
  vi.mocked(readRootRestorationState).mockResolvedValue('idle');
  vi.mocked(retainedNormalBootstrapCapability).mockResolvedValue(true);
  status.mockResolvedValue({ required: true, state: 'ready', bootstrapLeaseId: 'expired-lease' });
  expect(await run()).toBe('ordinary');
  expect(status).toHaveBeenCalledExactlyOnceWith('proof', expect.any(AbortSignal));
  expect(readTerminalJson).not.toHaveBeenCalled();
});

it('does not create a new recovery lock from unavailable old proof while root is idle', async () => {
  vi.stubEnv('ORBIS_HOST_SOCKET', '/run/orbis/host.sock');
  vi.mocked(readRootRestorationState).mockResolvedValue('idle');
  vi.mocked(retainedNormalBootstrapCapability).mockResolvedValue(true);
  terminalProof.mockRejectedValueOnce(new Error('old proof unavailable'));
  expect(await run()).toBe('ordinary');
  expect(setRestoreRecoveryRequired).not.toHaveBeenCalled();
});
