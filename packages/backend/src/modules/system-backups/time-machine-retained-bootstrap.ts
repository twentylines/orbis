import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { type } from 'arktype';
import { timeMachineIdSchema as uuid, timeMachineHashSchema as hash } from '@runtipi/common/schemas/time-machine';
import { canonicalPublicationJson } from '../host-updates/host-controller-publication';
import { retainedPlatformSchema, retainedPublicationSchema } from './time-machine-retained-phase-client';
import { restoreBootstrapSchema } from './backup-restore-bootstrap';
import { BackupRestoreJournal, type RestoreJournal } from './backup-restore-journal';
import { readRetainedRestoreReceipt } from './time-machine-restore-admission';
import { withRestoreLease } from './backup-restore-lease';
import { readTerminalJson, writeTerminalJson } from './backup-restore-terminal-record';

const digest = type('string').narrow((value) => /^sha256:[a-f0-9]{64}$/.test(value));
const target = type({
  publication: retainedPublicationSchema,
  creationReference: digest,
  platform: retainedPlatformSchema,
  platformManifestDigest: digest,
  configDigest: digest,
}).onUndeclaredKey('reject');
export const retainedSourceBindingSchema = type({
  originalJournalSha256: hash,
  bootstrapSha256: hash,
  admissionSha256: hash,
  sourceSealSha256: hash,
  legacyManifestSha256: hash,
  runtimeManifestSha256: hash,
}).onUndeclaredKey('reject');
export const retainedRootBindingSchema = type({
  restoreId: uuid,
  nonce: uuid,
  pointId: uuid,
  workerId: hash,
  originalController: hash,
  candidateController: hash,
  verifierController: hash,
  target,
  migrationsPath: 'string',
  workerSnapshot: 'unknown',
  sourceBinding: retainedSourceBindingSchema,
}).onUndeclaredKey('reject');
const statusSchema = type({
  version: '1',
  transactionId: uuid,
  pointId: uuid,
  state: "'allocated'",
  decision: 'null',
  recoverable: 'boolean',
  admissionSha256: hash,
  binding: retainedRootBindingSchema,
}).onUndeclaredKey('reject');
export type RetainedRootBinding = typeof retainedRootBindingSchema.infer;
const same = (a: unknown, b: unknown) => canonicalPublicationJson(a) === canonicalPublicationJson(b);
const fail = () => new Error('Retained restore binding requires protected host recovery.');
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export async function readRetainedBoundRecord(file: string) {
  const input = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = await input.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.mode & 0o077 ||
      before.size > 512 * 1024 ||
      (process.getuid && before.uid !== process.getuid())
    )
      throw fail();
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const part = await input.read(buffer, offset, buffer.length - offset, offset);
      if (!part.bytesRead) break;
      offset += part.bytesRead;
    }
    if (offset !== before.size) throw fail();
    const bytes = buffer.subarray(0, offset);
    const after = await input.stat();
    const current = await fs.lstat(file);
    if (
      bytes.length !== before.size ||
      [after, current].some((stat) =>
        ['ino', 'dev', 'size', 'mode', 'uid', 'nlink', 'mtimeMs', 'ctimeMs'].some((key) => Reflect.get(stat, key) !== Reflect.get(before, key)),
      )
    )
      throw fail();
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown, sha256: sha(bytes) };
  } finally {
    await input.close();
  }
}

/** Caller supplies a fresh authenticated root status reader; the local record is evidence, never authority. */
export async function bindRetainedJournal(options: {
  store: string;
  restoreId: string;
  nonce: string;
  pointId: string;
  ownerId: number;
  importId: string;
  expectedTarget: typeof target.infer;
  expectedRuntimeManifestSha256: string;
  rootStatus: () => Promise<unknown>;
  verifyRootWorker: (binding: RetainedRootBinding) => Promise<void>;
}) {
  const file = path.join(options.store, options.restoreId, 'retained-binding.json');
  return withRestoreLease(options.store, async () => {
    const journal = await BackupRestoreJournal.active(options.store);
    if (
      !journal ||
      journal.state.id !== options.restoreId ||
      journal.state.nonce !== options.nonce ||
      journal.state.phase !== 'staging' ||
      journal.state.decision !== null
    )
      throw fail();
    const receipt = await readRetainedRestoreReceipt(journal);
    if (!receipt || receipt.ownerId !== options.ownerId || receipt.importId !== options.importId || receipt.binding.pointId !== options.pointId)
      throw fail();
    const readRoot = async () => {
      const status = statusSchema(await options.rootStatus());
      if (
        status instanceof type.errors ||
        status.transactionId !== options.restoreId ||
        status.pointId !== options.pointId ||
        status.admissionSha256 !== status.binding.sourceBinding.admissionSha256 ||
        status.binding.restoreId !== options.restoreId ||
        status.binding.nonce !== options.nonce ||
        status.binding.pointId !== options.pointId ||
        status.binding.originalController !== journal.state.originalController ||
        status.binding.migrationsPath !== `/data/backups/restores/${options.restoreId}/retained/migrations` ||
        !same(status.binding.target, options.expectedTarget) ||
        new Set([status.binding.originalController, status.binding.candidateController, status.binding.verifierController, status.binding.workerId])
          .size !== 4
      )
        throw fail();
      return status.binding;
    };
    const binding = await readRoot();
    await options.verifyRootWorker(binding);
    const current = journal.state;
    const prior = await readTerminalJson(file, 512 * 1024);
    let oldState: RestoreJournal;
    if (prior === undefined) {
      if (current.candidateController !== current.originalController) throw fail();
      oldState = current;
      await writeTerminalJson(file, { version: 1, oldState, binding }, true);
    } else {
      if (
        !prior ||
        typeof prior !== 'object' ||
        Array.isArray(prior) ||
        Object.keys(prior).sort().join('\0') !== ['binding', 'oldState', 'version'].join('\0') ||
        !('version' in prior) ||
        prior.version !== 1 ||
        !('binding' in prior) ||
        !same(prior.binding, binding) ||
        !('oldState' in prior)
      )
        throw fail();
      oldState = prior.oldState as RestoreJournal;
    }
    if (
      !oldState ||
      oldState.id !== options.restoreId ||
      oldState.nonce !== options.nonce ||
      oldState.phase !== 'staging' ||
      oldState.decision !== null ||
      oldState.originalController !== binding.originalController ||
      oldState.candidateController !== oldState.originalController
    )
      throw fail();
    const next: RestoreJournal = {
      ...oldState,
      candidateController: binding.candidateController,
      verifierController: binding.verifierController,
      worker: binding.workerId,
    };
    if (!same(current, oldState) && !same(current, next)) throw fail();
    const bootstrapRecord = await readRetainedBoundRecord(path.join(journal.directory, 'bootstrap.json'));
    const admissionRecord = await readRetainedBoundRecord(path.join(journal.directory, 'time-machine-admission.json'));
    const bootstrap = restoreBootstrapSchema(bootstrapRecord.value);
    if (
      bootstrap instanceof type.errors ||
      binding.sourceBinding.originalJournalSha256 !== sha(canonicalPublicationJson(oldState)) ||
      binding.sourceBinding.bootstrapSha256 !== bootstrapRecord.sha256 ||
      binding.sourceBinding.admissionSha256 !== admissionRecord.sha256 ||
      binding.sourceBinding.sourceSealSha256 !== sha(canonicalPublicationJson(bootstrap.source)) ||
      binding.sourceBinding.legacyManifestSha256 !== receipt.binding.manifestSha256 ||
      binding.sourceBinding.legacyManifestSha256 !== bootstrap.source.manifest.sha256 ||
      binding.sourceBinding.runtimeManifestSha256 !== options.expectedRuntimeManifestSha256 ||
      bootstrap.ownerId !== options.ownerId ||
      bootstrap.identity.id !== oldState.id ||
      bootstrap.identity.nonce !== oldState.nonce ||
      bootstrap.identity.original.id !== oldState.originalController ||
      bootstrap.identity.candidate.id !== oldState.candidateController ||
      bootstrap.identity.verifier.id !== oldState.verifierController ||
      bootstrap.identity.worker?.id !== oldState.worker
    )
      throw fail();
    if (!same(await readRoot(), binding)) throw fail();
    await options.verifyRootWorker(binding);
    if (same(current, oldState)) await writeTerminalJson(path.join(journal.directory, 'restore.json'), next);
    const rebound = await BackupRestoreJournal.active(options.store);
    if (!rebound || !same(rebound.state, next) || !same(await readRoot(), binding)) throw fail();
    return rebound;
  });
}
