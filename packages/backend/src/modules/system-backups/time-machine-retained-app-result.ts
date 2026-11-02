import { createHash } from 'node:crypto';
import path from 'node:path';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import type { BackupRestoreJournal } from './backup-restore-journal';
import { readRestoreOperation } from './backup-restore-runtime';
import { readTerminalJson } from './backup-restore-terminal-record';
import { readRetainedRestoreReceipt } from './time-machine-restore-admission';
import { readRetainedBoundRecord } from './time-machine-retained-bootstrap';
import { readRootBoundImageExpectations } from './time-machine-retained-images';
import { RetainedRootTransaction } from './time-machine-retained-root-client';

const fail = () => new Error('Protected restored app verification requires recovery.');
const same = (a: unknown, b: unknown) => canonicalPublicationJson(a) === canonicalPublicationJson(b);

/** Root owns app effects. The candidate only checks its fresh protected result and bound inputs. */
export async function verifyRetainedCandidateApps(journal: BackupRestoreJournal, dataDirectory: string, hostname: string, signal: AbortSignal) {
  const state = await journal.refresh();
  if (state.phase !== 'committing' || state.decision !== 'commit' || !state.candidateController.startsWith(hostname)) throw fail();
  const transaction = await RetainedRootTransaction.read(journal.directory);
  const first = await transaction.candidateAppResult(signal);
  const binding = first.binding;
  if (
    binding.restoreId !== state.id ||
    binding.nonce !== state.nonce ||
    binding.originalController !== state.originalController ||
    binding.candidateController !== state.candidateController ||
    binding.verifierController !== state.verifierController ||
    binding.workerId !== state.worker
  )
    throw fail();
  const record = await readTerminalJson(path.join(journal.directory, 'retained-binding.json'));
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    Object.keys(record).sort().join('\0') !== ['binding', 'oldState', 'version'].join('\0') ||
    !('version' in record) ||
    record.version !== 1 ||
    !('binding' in record) ||
    !same(record.binding, binding)
  )
    throw fail();
  const receipt = await readRetainedRestoreReceipt(journal);
  const bootstrap = await readRetainedBoundRecord(path.join(journal.directory, 'bootstrap.json'));
  const admission = await readRetainedBoundRecord(path.join(journal.directory, 'time-machine-admission.json'));
  if (
    !receipt ||
    receipt.binding.pointId !== binding.pointId ||
    receipt.binding.manifestSha256 !== binding.sourceBinding.legacyManifestSha256 ||
    bootstrap.sha256 !== binding.sourceBinding.bootstrapSha256 ||
    admission.sha256 !== binding.sourceBinding.admissionSha256
  )
    throw fail();
  await readRestoreOperation(journal, first.operationSha256);
  const expected = await readRootBoundImageExpectations({
    dataDirectory,
    restoreId: state.id,
    pointId: binding.pointId,
    manifestSha256: binding.sourceBinding.runtimeManifestSha256,
    target: binding.target,
    signal,
  });
  const manifest = expected.expectedManifest;
  if (
    manifest.schema !== 'orbis.time-machine-runtime.v6' ||
    !('expectedAppRuntime' in expected) ||
    !expected.expectedAppRuntime ||
    first.imageCaptureSha256 !== manifest.imageCaptureSha256 ||
    first.imageInventorySha256 !== manifest.imageInventorySha256 ||
    first.appRuntimeSha256 !== manifest.appRuntimeSha256 ||
    createHash('sha256').update(expected.expectedAppRuntime.read()).digest('hex') !== first.appRuntimeSha256
  )
    throw fail();
  const historical = expected.expectedAppRuntime.metadata.containers;
  if (first.containers.length !== historical.length) throw fail();
  const roleIds = new Set([binding.originalController, binding.candidateController, binding.verifierController, binding.workerId]);
  for (let i = 0; i < historical.length; i++) {
    const source = historical[i];
    const result = first.containers[i];
    if (
      !source ||
      !result ||
      result.appUrn !== source.appUrn ||
      result.service !== source.service ||
      result.ordinal !== source.ordinal ||
      result.wasRunning !== source.wasRunning ||
      result.imageId !== source.image.creationReference ||
      roleIds.has(result.id)
    )
      throw fail();
  }
  const second = await transaction.candidateAppResult(signal);
  if (
    first.appEffectsSha256 !== second.appEffectsSha256 ||
    first.operationSha256 !== second.operationSha256 ||
    first.imageCaptureSha256 !== second.imageCaptureSha256 ||
    first.imageInventorySha256 !== second.imageInventorySha256 ||
    first.appRuntimeSha256 !== second.appRuntimeSha256 ||
    first.expiresAt !== second.expiresAt ||
    !same(first.binding, second.binding) ||
    !same(first.containers, second.containers)
  )
    throw fail();
}
