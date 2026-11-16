import { type } from 'arktype';
import { resetSafetyArchiveLimits } from './reset-safety-archive-limits';

const uuid = type('string').narrow((value) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value));
const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
export const resetSafetyArchiveCommitmentSchema = type({
  format: "'orbis-reset-safety-commitment'",
  version: '1',
  resetId: uuid,
  backupId: uuid,
  accounts: "'keep' | 'remove'",
  users: type('number.integer > 0').narrow(Number.isSafeInteger).array().atLeastLength(1).atMostLength(256),
  selectionSha256: hash,
  fullScopeSha256: hash,
  exportInventorySha256: hash,
  targetInventorySha256: hash,
  sha256: hash,
  bytes: type('number.integer > 0').narrow((value) => Number.isSafeInteger(value) && value <= resetSafetyArchiveLimits.archiveBytes),
})
  .onDeepUndeclaredKey('reject')
  .narrow((value) => value.users.every((id, index) => index === 0 || id > (value.users[index - 1] ?? 0)));

export type ResetSafetyArchiveCommitment = Readonly<Omit<typeof resetSafetyArchiveCommitmentSchema.infer, 'users'> & { users: readonly number[] }>;
