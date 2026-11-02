import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { type } from 'arktype';
import { readRootRestorationState } from '@/common/restoration-root-status';
import { canonicalPublicationJson } from '@/modules/host-updates/host-controller-publication';
import type { QueueFactory } from '../queue/queue.factory';
import { BackupRestoreJournal } from './backup-restore-journal';
import { readTerminalJson, writeTerminalJson } from './backup-restore-terminal-record';
import { RetainedRootTransaction } from './time-machine-retained-root-client';

const receiptSchema = type({
  version: '1',
  transactionId: 'string',
  pointId: 'string',
  terminalProofSha256: 'string',
  operationSha256: 'string',
  candidateId: 'string',
  bootstrapLeaseId: 'string',
  queueGeneration: 'number.integer > 0',
  queues: type({ name: 'string', messagesReady: '0', consumers: '1' }).onUndeclaredKey('reject').array(),
  readyAt: 'number.integer >= 0',
}).onUndeclaredKey('reject');
const names = ['app-events-queue', 'repo-queue', 'system-events-queue'];

export async function finishRetainedNormalBootstrap(journal: BackupRestoreJournal, queue: QueueFactory, signal: AbortSignal) {
  let transaction: Awaited<ReturnType<typeof RetainedRootTransaction.read>> | undefined;
  try {
    const maintenance = await readRootRestorationState();
    if (!['checking', 'idle'].includes(maintenance ?? '') || (await BackupRestoreJournal.active(path.dirname(journal.directory))))
      throw new Error('Retained bootstrap is not waiting for settlement.');
    transaction = await RetainedRootTransaction.read(journal.directory);
    const proof = await transaction.terminalProof(signal);
    if (
      !proof.binding ||
      !proof.operationSha256 ||
      proof.state !== 'complete' ||
      proof.decision !== 'commit' ||
      proof.binding.nonce !== journal.state.nonce ||
      proof.binding.candidateController !== journal.state.candidateController ||
      proof.survivor.id !== journal.state.candidateController
    )
      throw new Error('Retained bootstrap ownership changed.');
    const status = await transaction.normalBootstrapStatus(proof.proofSha256, signal);
    if (!status.required) throw new Error('Retained bootstrap is unavailable.');
    if (maintenance === 'idle' && status.state !== 'ready') throw new Error('Retained bootstrap is not ready.');
    if (status.state === 'pending') await transaction.terminalFinalize(proof.proofSha256, signal);
    const lease =
      status.state === 'pending'
        ? await transaction.normalBootstrap(
            { nonce: journal.state.nonce, operationSha256: proof.operationSha256, terminalProofSha256: proof.proofSha256, binding: proof.binding },
            signal,
          )
        : undefined;
    const leaseId = lease?.bootstrapLeaseId ?? status.bootstrapLeaseId;
    if (!leaseId) throw new Error('Retained bootstrap lease is unavailable.');
    const file = path.join(journal.directory, 'normal-bootstrap', leaseId, 'ready.json');
    let consumers: Awaited<ReturnType<QueueFactory['prepareRetainedConsumers']>> | undefined;
    if (lease) {
      const readiness = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      while (!queue.isReady()) await delay(100, undefined, { signal: readiness });
      consumers = await queue.prepareRetainedConsumers(readiness);
      if (Date.now() >= lease.expiresAt) throw new Error('Retained bootstrap lease expired.');
      const receipt = {
        version: 1,
        transactionId: journal.state.id,
        pointId: proof.pointId,
        terminalProofSha256: proof.proofSha256,
        operationSha256: proof.operationSha256,
        candidateId: proof.survivor.id,
        bootstrapLeaseId: leaseId,
        queueGeneration: consumers.queueGeneration,
        queues: consumers.queues,
        readyAt: Date.now(),
      };
      await consumers.recheck();
      await writeTerminalJson(file, receipt, true);
    }
    const receipt = receiptSchema(await readTerminalJson(file, 8192));
    if (
      receipt instanceof type.errors ||
      receipt.transactionId !== journal.state.id ||
      receipt.pointId !== proof.pointId ||
      receipt.terminalProofSha256 !== proof.proofSha256 ||
      receipt.operationSha256 !== proof.operationSha256 ||
      receipt.candidateId !== proof.survivor.id ||
      receipt.bootstrapLeaseId !== leaseId ||
      !Number.isSafeInteger(receipt.queueGeneration) ||
      !Number.isSafeInteger(receipt.readyAt) ||
      canonicalPublicationJson(receipt.queues) !== canonicalPublicationJson(names.map((name) => ({ name, messagesReady: 0, consumers: 1 })))
    )
      throw new Error('Retained bootstrap receipt changed.');
    await consumers?.recheck();
    await transaction.normalBootstrapComplete(proof.proofSha256, leaseId, signal);
    if ((await readRootRestorationState()) !== 'idle' || (await BackupRestoreJournal.active(path.dirname(journal.directory))))
      throw new Error('Retained bootstrap is not settled.');
  } catch (error) {
    if (transaction) await transaction.launch('recover', AbortSignal.timeout(60_000)).catch(() => undefined);
    throw error;
  }
}
