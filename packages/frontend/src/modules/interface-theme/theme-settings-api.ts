import { interfaceThemeIdentitySchema, interfaceThemeSettingsEntryAllows } from '@runtipi/common/schemas/interface-theme';
import { builtinInterfaceTheme, legacyThemeVersions, registeredInterfaceTheme } from '@runtipi/common/schemas/interface-theme-registry';
import { resolveInterfaceThemeSettings, type ResolvedInterfaceThemeSettings } from '@runtipi/common/schemas/interface-theme-resolution';
import {
  themeSettingsDocumentSchema,
  themeSettingsMigrationSchema,
  themeSettingsUpdateSchema,
  type ThemeSettingsDocument,
  type ThemeSettingsUpdate,
} from '@runtipi/common/schemas/theme-settings';
import type { InterfaceThemeIdentity } from '@runtipi/common/schemas/interface-theme';

export type ThemeSettingsSnapshot = ThemeSettingsDocument & {
  selected: InterfaceThemeIdentity | null;
  current: ResolvedInterfaceThemeSettings;
  builtinFallback: ResolvedInterfaceThemeSettings;
};
export type ThemeSettingsFailure = 'compatibility' | 'authentication' | 'conflict' | 'validation' | 'unavailable' | 'unsupported';
export class ThemeSettingsError extends Error {
  constructor(
    readonly kind: ThemeSettingsFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ThemeSettingsError';
  }
}

function matchesReviewed(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return Array.isArray(value) && value.length === expected.length && expected.every((item, index) => matchesReviewed(value[index], item));
  if (expected && typeof expected === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const reviewed = expected as Record<string, unknown>;
    const object = value as Record<string, unknown>;
    return (
      Object.keys(object).sort().join(',') === Object.keys(reviewed).sort().join(',') &&
      Object.keys(reviewed).every((key) => matchesReviewed(object[key], reviewed[key]))
    );
  }
  return value === expected;
}

export function decodeThemeSettingsSnapshot(value: unknown): ThemeSettingsSnapshot {
  const invalid = () => new ThemeSettingsError('unsupported', 'This server returned unsupported theme settings. Your appearance has been kept.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).sort().join(',') !== 'builtinFallback,current,formatVersion,legacyMigration,revision,selected,settings') throw invalid();
  const { formatVersion, revision, legacyMigration, settings, selected } = object;
  const document = { formatVersion, revision, legacyMigration, settings };
  if (!themeSettingsDocumentSchema.allows(document) || !(selected === null || interfaceThemeIdentitySchema.allows(selected))) throw invalid();
  for (const entry of document.settings.entries) {
    const descriptor = [builtinInterfaceTheme, ...legacyThemeVersions.map((version) => registeredInterfaceTheme({ id: entry.id, version }))].find(
      (candidate) => candidate?.id === entry.id && candidate.settingsVersion === entry.settingsVersion,
    );
    if (descriptor && !interfaceThemeSettingsEntryAllows(descriptor, entry)) throw invalid();
  }
  const current = resolveInterfaceThemeSettings(selected, document.settings);
  const builtinFallback = resolveInterfaceThemeSettings(null, document.settings);
  // Reject inconsistent projections and definitions; render only the local reviewed definitions.
  if (!matchesReviewed(object.current, current) || !matchesReviewed(object.builtinFallback, builtinFallback)) throw invalid();
  return { ...document, selected, current, builtinFallback };
}

export interface ThemeSettingsClient {
  read(signal?: AbortSignal): Promise<ThemeSettingsSnapshot>;
  migrate(expectedRevision: number, signal?: AbortSignal): Promise<ThemeSettingsSnapshot>;
  update(value: ThemeSettingsUpdate, signal?: AbortSignal): Promise<ThemeSettingsSnapshot>;
}

export function createThemeSettingsClient(fetcher: typeof fetch = fetch): ThemeSettingsClient {
  const request = async (method: 'GET' | 'PUT' | 'POST', body?: unknown, signal?: AbortSignal) => {
    const response = await fetcher(`/api/theme-settings${method === 'POST' ? '/migrate' : ''}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if (response.status === 404 || response.status === 405)
        throw new ThemeSettingsError(
          'compatibility',
          'This server uses shared appearance settings. Per-theme settings need a newer server.',
          response.status,
        );
      if (response.status === 401 || response.status === 403)
        throw new ThemeSettingsError('authentication', 'Sign in again in this browser to save theme settings.', response.status);
      if (response.status === 409)
        throw new ThemeSettingsError(
          'conflict',
          'Theme settings changed or need review. Your draft is kept; reload before saving again.',
          response.status,
        );
      if (response.status === 400)
        throw new ThemeSettingsError('validation', 'These theme settings could not be validated. Check the controls before saving.', response.status);
      throw new ThemeSettingsError(
        'unavailable',
        'Theme settings could not be loaded or saved. Your draft is kept; retry when connected.',
        response.status,
      );
    }
    let value: unknown;
    try {
      const text = await response.text();
      if (text.length > 524288) throw new Error('Oversized settings');
      value = JSON.parse(text);
    } catch {
      throw new ThemeSettingsError('unsupported', 'The server returned invalid theme settings. Your appearance has been kept.');
    }
    return decodeThemeSettingsSnapshot(value);
  };
  return {
    read: (signal) => request('GET', undefined, signal),
    migrate: (expectedRevision, signal) => {
      const body = { expectedRevision };
      if (!themeSettingsMigrationSchema.allows(body))
        return Promise.reject(new ThemeSettingsError('validation', 'Reload theme settings before migrating.'));
      return request('POST', body, signal);
    },
    update: (value, signal) => {
      if (!themeSettingsUpdateSchema.allows(value)) return Promise.reject(new ThemeSettingsError('validation', 'These theme settings are invalid.'));
      return request('PUT', value, signal);
    },
  };
}
