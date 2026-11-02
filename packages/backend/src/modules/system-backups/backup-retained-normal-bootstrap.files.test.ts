import { beforeEach, expect, it, vi } from 'vitest';
import { finishRetainedNormalBootstrap } from './backup-retained-normal-bootstrap';
import { RetainedRootTransaction } from './time-machine-retained-root-client';
import { readTerminalJson, writeTerminalJson } from './backup-restore-terminal-record';
import { readRootRestorationState } from '@/common/restoration-root-status';
import { BackupRestoreJournal } from './backup-restore-journal';

vi.mock('./backup-restore-journal', () => ({ BackupRestoreJournal: { active: vi.fn() } }));
vi.mock('@/common/restoration-root-status', () => ({ readRootRestorationState: vi.fn() }));
vi.mock('./backup-restore-terminal-record', () => ({ readTerminalJson: vi.fn(), writeTerminalJson: vi.fn() }));
vi.mock('./time-machine-retained-root-client', () => ({ RetainedRootTransaction: { read: vi.fn() } }));
const id = 'd'.repeat(64);
const journal = { directory: '/private/transaction', state: { id: 'transaction', nonce: 'nonce', candidateController: id } };
const proof = {
  binding: { nonce: 'nonce', candidateController: id },
  operationSha256: 'operation',
  state: 'complete',
  decision: 'commit',
  survivor: { id },
  pointId: 'point',
  proofSha256: 'proof',
};
const queues = ['app-events-queue', 'repo-queue', 'system-events-queue'].map((name) => ({ name, messagesReady: 0, consumers: 1 }));
const receipt = {
  version: 1,
  transactionId: 'transaction',
  pointId: 'point',
  terminalProofSha256: 'proof',
  operationSha256: 'operation',
  candidateId: id,
  bootstrapLeaseId: 'lease',
  queueGeneration: 1,
  queues,
  readyAt: 1,
};
const recheck = vi.fn();
const complete = vi.fn();
const finalize = vi.fn();
const status = vi.fn();
const lease = vi.fn();
const queue = { isReady: vi.fn().mockReturnValue(true), prepareRetainedConsumers: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readRootRestorationState).mockResolvedValueOnce('checking').mockResolvedValue('idle');
  vi.mocked(BackupRestoreJournal.active).mockResolvedValue(undefined);
  vi.mocked(RetainedRootTransaction.read).mockResolvedValue({
    terminalProof: vi.fn().mockResolvedValue(proof),
    normalBootstrapStatus: status,
    normalBootstrap: lease,
    normalBootstrapComplete: complete,
    terminalFinalize: finalize,
    launch: vi.fn().mockResolvedValue(undefined),
  } as never);
  status.mockResolvedValue({ required: true, state: 'pending', bootstrapLeaseId: null });
  lease.mockResolvedValue({ bootstrapLeaseId: 'lease', expiresAt: Date.now() + 60000 });
  queue.prepareRetainedConsumers.mockResolvedValue({ queueGeneration: 1, queues, recheck });
  vi.mocked(writeTerminalJson).mockResolvedValue(undefined);
  vi.mocked(readTerminalJson).mockResolvedValue(receipt);
});
it('keeps the hold through consumers, durable receipt, acknowledgement and root idle', async () => {
  await finishRetainedNormalBootstrap(journal as never, queue as never, new AbortController().signal);
  expect(finalize).toHaveBeenCalledBefore(lease);
  expect(writeTerminalJson).toHaveBeenCalledBefore(complete);
  expect(complete).toHaveBeenCalledExactlyOnceWith('proof', 'lease', expect.any(AbortSignal));
});
it('replays only the protected ready lease without issuing a new lease or receipt', async () => {
  status.mockResolvedValue({ required: true, state: 'ready', bootstrapLeaseId: 'lease' });
  await finishRetainedNormalBootstrap(journal as never, queue as never, new AbortController().signal);
  expect(lease).not.toHaveBeenCalled();
  expect(writeTerminalJson).not.toHaveBeenCalled();
  expect(queue.prepareRetainedConsumers).not.toHaveBeenCalled();
  expect(recheck).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledOnce();
});
it('retains the hold when the acknowledgement or protected idle check fails', async () => {
  complete.mockRejectedValue(new Error('unavailable'));
  await expect(finishRetainedNormalBootstrap(journal as never, queue as never, new AbortController().signal)).rejects.toThrow();
});
it('keeps the hold and requests recovery if the consumer generation changes before acknowledgement', async () => {
  recheck.mockRejectedValueOnce(new Error('generation changed'));
  await expect(finishRetainedNormalBootstrap(journal as never, queue as never, new AbortController().signal)).rejects.toThrow();
  expect(complete).not.toHaveBeenCalled();
  const transaction = await vi.mocked(RetainedRootTransaction.read).mock.results[0]?.value;
  expect(transaction?.launch).toHaveBeenCalledWith('recover', expect.any(AbortSignal));
});
it('does not release after an acknowledgement while root remains checking', async () => {
  vi.mocked(readRootRestorationState).mockReset().mockResolvedValue('checking');
  await expect(finishRetainedNormalBootstrap(journal as never, queue as never, new AbortController().signal)).rejects.toThrow();
  expect(complete).toHaveBeenCalledOnce();
});
