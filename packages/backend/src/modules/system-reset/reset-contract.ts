import path from 'node:path';
import { type } from 'arktype';
import { WALLPAPER_LIMIT } from '../desktop-preferences/desktop-wallpaper-limits';

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
