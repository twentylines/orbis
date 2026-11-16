import path from 'node:path';
import { createHash } from 'node:crypto';
import { type } from 'arktype';
import { WALLPAPER_LIMIT } from '../desktop-preferences/desktop-wallpaper-limits';
import { resetSafetyArchiveCommitmentSchema, type ResetSafetyArchiveCommitment } from '../system-backups/reset-safety-commitment-contract';

/**
 * The reset journal contract and the exact preference scope.
 *
 * This module has no storage behaviour so the authority, the preference store and the storage facade can
 * share one schema and one target list without importing each other.
 */

export type ResetAccounts = 'keep' | 'remove';
export function resetSensitiveActionBinding(accounts: ResetAccounts) {
  if (accounts !== 'keep' && accounts !== 'remove') throw new Error('Invalid reset account choice.');
  return createHash('sha256').update(`orbis-reset-v1\n${accounts}\napps-and-data-preserved`).digest('hex');
}
const journalFields = {
  '+': 'reject',
  id: 'string.uuid',
  controller: 'string > 0 & string <= 253',
  accounts: "'keep' | 'remove'",
  users: 'number.integer > 0[]',
  phase: "'prepared' | 'preferences' | 'accounts' | 'complete' | 'recovery'",
  createdAt: 'number.integer > 0',
} as const;
export const legacyResetJournalSchema = type({ ...journalFields, version: '1' }).narrow(
  (value) => value.users.length <= 256 && new Set(value.users).size === value.users.length && value.users.every(Number.isSafeInteger),
);
export type LegacyResetJournal = typeof legacyResetJournalSchema.infer;
export const archiveResetJournalSchema = type({ ...journalFields, version: '2', safety: resetSafetyArchiveCommitmentSchema }).narrow(
  (value) =>
    value.id === value.safety.resetId &&
    value.accounts === value.safety.accounts &&
    Number.isSafeInteger(value.createdAt) &&
    value.users.length === value.safety.users.length &&
    [...value.users].sort((a, b) => a - b).every((id, index) => id === value.safety.users[index]),
);
export const resetJournalSchema = legacyResetJournalSchema.or(archiveResetJournalSchema);
export type ResetJournal = typeof resetJournalSchema.infer;

export function assertResetJournalReplacement(previous: ResetJournal | null, next: ResetJournal) {
  if (previous?.version !== 2) return;
  if (
    next.version !== 2 ||
    previous.id !== next.id ||
    previous.controller !== next.controller ||
    previous.accounts !== next.accounts ||
    previous.createdAt !== next.createdAt ||
    JSON.stringify(previous.users) !== JSON.stringify(next.users) ||
    Object.keys(previous.safety).some((key) => JSON.stringify(Reflect.get(previous.safety, key)) !== JSON.stringify(Reflect.get(next.safety, key)))
  )
    throw new Error('The reset archive journal binding must be preserved for recovery review.');
}

/** Binds durable storage evidence; the resulting journal grants no erasure or restore authority. */
export function archiveBackedResetJournal(journal: LegacyResetJournal, commitment: ResetSafetyArchiveCommitment) {
  const source = legacyResetJournalSchema.assert(structuredClone(journal));
  if (source.phase !== 'prepared') throw new Error('The reset archive journal needs a fresh prepared intent.');
  const value = archiveResetJournalSchema.assert({ ...source, version: 2, safety: structuredClone(commitment) });
  Object.freeze(value.users);
  Object.freeze(value.safety.users);
  Object.freeze(value.safety);
  return Object.freeze(value);
}

export const resetScopes = ['desktop', 'onboarding', 'theme-settings', 'theme-packs', 'wallpapers'] as const;

export const RESET_PREFERENCE_FILE_LIMIT = 8 * 1024 * 1024;

/** Resolve from the original target, never from a descriptor path or a staging filename. */
export function resetPreferenceFileLimit(dataDir: string, target: string) {
  const name = path.basename(target);
  const account = /^([1-9][0-9]*)\.image(?:\.saved)?$/.exec(name)?.[1];
  return path.dirname(target) === path.join(path.resolve(dataDir), 'state', 'wallpapers') && account && Number.isSafeInteger(Number(account))
    ? WALLPAPER_LIMIT
    : RESET_PREFERENCE_FILE_LIMIT;
}

/** Preference targets are relative to the data directory so both storage layouts derive the same list. */
export function resetTargetNames(value: ResetJournal) {
  resetJournalSchema.assert(value);
  return [
    ...value.users.flatMap((id) => [
      ...resetScopes.map((scope) => `${scope}/${id}${scope === 'theme-packs' ? '' : scope === 'wallpapers' ? '.image' : '.json'}`),
      `wallpapers/${id}.image.saved`,
    ]),
    '.orbis-onboarding-origin.json',
    ...(value.accounts === 'remove' ? ['password-change-request'] : []),
  ];
}

export function resetTargetPath(dataDir: string, relative: string) {
  return relative === '.orbis-onboarding-origin.json'
    ? path.join(path.resolve(dataDir), relative)
    : path.join(path.resolve(dataDir), 'state', relative);
}

export function resetTargetPaths(dataDir: string, value: ResetJournal) {
  return resetTargetNames(value).map((relative) => resetTargetPath(dataDir, relative));
}
