import path from 'node:path';
import { type } from 'arktype';

/**
 * The reset journal contract and the exact preference scope.
 *
 * This module has no storage behaviour so the authority, the preference store and the storage facade can
 * share one schema and one target list without importing each other.
 */

export type ResetAccounts = 'keep' | 'remove';
export const resetJournalSchema = type({
  '+': 'reject',
  version: '1',
  id: 'string.uuid',
  controller: 'string > 0 & string <= 253',
  accounts: "'keep' | 'remove'",
  users: 'number.integer > 0[]',
  phase: "'prepared' | 'preferences' | 'accounts' | 'complete' | 'recovery'",
  createdAt: 'number.integer > 0',
}).narrow((value) => value.users.length <= 256 && new Set(value.users).size === value.users.length && value.users.every(Number.isSafeInteger));
export type ResetJournal = typeof resetJournalSchema.infer;

export const resetScopes = ['desktop', 'onboarding', 'theme-settings', 'theme-packs', 'wallpapers'] as const;

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
