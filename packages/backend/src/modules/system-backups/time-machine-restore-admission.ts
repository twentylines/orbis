import path from 'node:path';
import { type } from 'arktype';
import { timeMachineHashSchema, timeMachineIdSchema } from '@runtipi/common/schemas/time-machine';
import { timeMachineRestoreBindingSchema, type TimeMachineRestoreBinding } from '@runtipi/common/schemas/time-machine-restore';
import { BackupRestoreJournal } from './backup-restore-journal';
import { readTerminalJson, writeTerminalJson } from './backup-restore-terminal-record';
import { withRestoreLease } from './backup-restore-lease';
import { restoreConflict } from './time-machine-restore-policy';

const receiptSchema = type({
  version: '1',
  restoreId: timeMachineIdSchema,
  nonce: timeMachineIdSchema,
  ownerId: 'number.integer > 0',
  importId: timeMachineIdSchema,
  binding: timeMachineRestoreBindingSchema,
  authorizationSha256: timeMachineHashSchema,
  authorizedAt: '0 < number.integer <= 9007199254740991',
}).onUndeclaredKey('reject');
export type RetainedRestoreReceipt = typeof receiptSchema.infer;
declare const permitBrand: unique symbol;
export type RetainedRestorePermit = Readonly<{ [permitBrand]: true }>;
const permits = new WeakMap<
  RetainedRestorePermit,
  { receipt: RetainedRestoreReceipt; directory: string; issuedAt: number; verify: () => Promise<void> }
>();
const file = (journal: BackupRestoreJournal) => path.join(journal.directory, 'time-machine-admission.json');
const sameBinding = (first: TimeMachineRestoreBinding, second: TimeMachineRestoreBinding) =>
  (['pointId', 'reviewId', 'archiveSha256', 'manifestSha256', 'machineId'] as const).every((key) => first[key] === second[key]);
const sameReceipt = (first: RetainedRestoreReceipt, second: RetainedRestoreReceipt) =>
  first.restoreId === second.restoreId &&
  first.nonce === second.nonce &&
  first.ownerId === second.ownerId &&
  first.importId === second.importId &&
  first.authorizedAt === second.authorizedAt &&
  first.authorizationSha256 === second.authorizationSha256 &&
  sameBinding(first.binding, second.binding);

export async function readRetainedRestoreReceipt(journal: BackupRestoreJournal) {
  const raw = await readTerminalJson(file(journal), 8192);
  if (raw === undefined) return undefined;
  const receipt = receiptSchema(raw);
  if (receipt instanceof type.errors || receipt.restoreId !== journal.state.id || receipt.nonce !== journal.state.nonce)
    throw restoreConflict('restore-recovery-required');
  return structuredClone(receipt);
}

// A receipt supports recovery/status only. The nonserializable permit is minted after fresh account proof.
export async function recordRetainedRestoreAdmission(
  journal: BackupRestoreJournal,
  ownerId: number,
  importId: string,
  binding: TimeMachineRestoreBinding,
  authorization: { sha256: string; verify: () => Promise<void> },
): Promise<RetainedRestorePermit> {
  const state = journal.state;
  const proposed = receiptSchema({
    version: 1,
    restoreId: state.id,
    nonce: state.nonce,
    ownerId,
    importId,
    binding,
    authorizationSha256: authorization.sha256,
    authorizedAt: Date.now(),
  });
  if (proposed instanceof type.errors) throw restoreConflict('authorization-invalid');
  const receipt = await withRestoreLease(path.dirname(journal.directory), async () => {
    const current = await journal.refresh();
    if (current.phase !== 'staging' || current.decision !== null) throw restoreConflict('restore-recovery-required');
    const existing = await readRetainedRestoreReceipt(journal);
    if (existing) {
      if (!sameReceipt(existing, { ...proposed, authorizedAt: existing.authorizedAt })) throw restoreConflict('authorization-invalid');
      return existing;
    }
    await writeTerminalJson(file(journal), proposed, true);
    const stored = await readRetainedRestoreReceipt(journal);
    if (!stored || !sameReceipt(stored, proposed)) throw restoreConflict('restore-recovery-required');
    return stored;
  });
  const permit = Object.freeze({}) as RetainedRestorePermit;
  permits.set(permit, { receipt, directory: journal.directory, issuedAt: Date.now(), verify: authorization.verify });
  return permit;
}

export function revokeRetainedRestorePermit(permit: RetainedRestorePermit) {
  permits.delete(permit);
}

export async function consumeRetainedRestorePermit(
  permit: RetainedRestorePermit,
  journal: BackupRestoreJournal,
  ownerId: number,
  importId: string,
  binding: TimeMachineRestoreBinding,
) {
  const value = permits.get(permit);
  permits.delete(permit);
  const now = Date.now();
  if (
    !value ||
    value.issuedAt > now ||
    now - value.issuedAt >= 120_000 ||
    value.directory !== journal.directory ||
    value.receipt.ownerId !== ownerId ||
    value.receipt.importId !== importId ||
    !sameBinding(value.receipt.binding, binding)
  )
    throw restoreConflict('authorization-invalid');
  await requireRetainedRestoreReceipt(journal, value.receipt);
  const verify = async () => {
    const now = Date.now();
    if (value.issuedAt > now || now - value.issuedAt >= 120_000) throw restoreConflict('authorization-expired');
    await value.verify();
  };
  await verify();
  return { receipt: structuredClone(value.receipt), verify };
}

export async function requireRetainedRestoreReceipt(journal: BackupRestoreJournal, expected: RetainedRestoreReceipt) {
  const state = await journal.refresh();
  const receipt = await readRetainedRestoreReceipt(journal);
  if (state.phase !== 'staging' || state.decision !== null || !receipt || !sameReceipt(receipt, expected))
    throw restoreConflict('restore-recovery-required');
}
