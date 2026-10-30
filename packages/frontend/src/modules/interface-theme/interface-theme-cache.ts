import type { InterfaceThemeDescriptor, InterfaceThemeIdentity, InterfaceThemeSettingsState } from '@runtipi/common/schemas/interface-theme';
import { interfaceThemeSettingsEntryAllows } from '@runtipi/common/schemas/interface-theme';
import {
  builtinInterfaceTheme,
  legacyThemeIdentities,
  legacyThemeVersions,
  registeredInterfaceTheme,
} from '@runtipi/common/schemas/interface-theme-registry';
import type { ResolvedInterfaceThemeSettings } from '@runtipi/common/schemas/interface-theme-resolution';
import type { ThemeSettingsDocument } from '@runtipi/common/schemas/theme-settings';
import { projectInterfaceThemePreferences, readInterfaceThemeEnvironment } from './interface-theme-projection';

type PublicDefinitions = Record<string, { versions: readonly string[]; descriptor: InterfaceThemeDescriptor }>;
export const publicInterfaceThemeDefinitions: PublicDefinitions = {
  [builtinInterfaceTheme.id]: { versions: [builtinInterfaceTheme.version], descriptor: builtinInterfaceTheme },
  ...Object.fromEntries(
    legacyThemeIdentities.map((identity) => {
      const descriptor = registeredInterfaceTheme({ id: identity.id, version: '1.1.0' });
      if (!descriptor) throw new Error('Missing reviewed legacy theme.');
      return [identity.id, { versions: legacyThemeVersions, descriptor }];
    }),
  ),
};
export const interfaceThemeCacheKey = 'orbis-public-theme-settings-v1';
export const interfaceThemeCacheLimit = 65536;
export const interfaceThemeCacheAge = 30 * 24 * 60 * 60_000;

// Shared verbatim by bootstrap and hydration; paths and definitions always come from this build.
export function decodeInterfaceThemeCache(
  raw: string | null,
  now = Date.now(),
  rules = { limit: interfaceThemeCacheLimit, age: interfaceThemeCacheAge, definitions: publicInterfaceThemeDefinitions },
): InterfaceThemeSettingsState | null {
  if (!raw || raw.length > rules.limit) return null;
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const keys = (value: Record<string, unknown>, expected: string) => Object.keys(value).sort().join(',') === expected;
  try {
    const cached: unknown = JSON.parse(raw);
    if (
      !record(cached) ||
      !keys(cached, 'savedAt,settings,version') ||
      cached.version !== 1 ||
      typeof cached.savedAt !== 'number' ||
      !Number.isSafeInteger(cached.savedAt) ||
      cached.savedAt > now ||
      now - cached.savedAt >= rules.age
    )
      return null;
    const state = cached.settings;
    if (
      !record(state) ||
      !keys(state, 'entries,formatVersion') ||
      state.formatVersion !== 1 ||
      !Array.isArray(state.entries) ||
      state.entries.length > 24
    )
      return null;
    const namespaces = new Set<string>();
    for (const entry of state.entries) {
      if (!record(entry) || !keys(entry, 'id,settingsVersion,values') || typeof entry.id !== 'string' || !Object.hasOwn(rules.definitions, entry.id))
        return null;
      const descriptor = rules.definitions[entry.id]?.descriptor;
      if (
        !descriptor ||
        entry.settingsVersion !== descriptor.settingsVersion ||
        namespaces.has(entry.id) ||
        !Array.isArray(entry.values) ||
        entry.values.length > 48
      )
        return null;
      namespaces.add(entry.id);
      const names = new Set<string>();
      for (const item of entry.values) {
        if (!record(item) || !keys(item, 'key,value') || typeof item.key !== 'string' || names.has(item.key)) return null;
        names.add(item.key);
        const definition = descriptor.settings.find((setting) => setting.key === item.key);
        if (!definition) return null;
        const value = item.value;
        if (definition.kind === 'boolean' && typeof value !== 'boolean') return null;
        if (definition.kind === 'colour' && value !== null && !(typeof value === 'string' && /^#[a-f0-9]{6}$/i.test(value))) return null;
        if (definition.kind === 'enum' && !definition.options.some((option) => option.value === value)) return null;
        if (
          definition.kind === 'integer' &&
          value !== null &&
          !(
            typeof value === 'number' &&
            Number.isSafeInteger(value) &&
            value >= definition.min &&
            value <= definition.max &&
            (value - definition.min) % definition.step === 0
          )
        )
          return null;
      }
    }
    return state as unknown as InterfaceThemeSettingsState;
  } catch {
    return null;
  }
}

export function resolvePublicInterfaceTheme(
  state: InterfaceThemeSettingsState | null,
  identity: InterfaceThemeIdentity,
  definitions: PublicDefinitions = publicInterfaceThemeDefinitions,
): ResolvedInterfaceThemeSettings | null {
  if (!state || !Object.hasOwn(definitions, identity.id)) return null;
  const approved = definitions[identity.id];
  if (!approved?.versions.includes(identity.version)) return null;
  const descriptor = { ...approved.descriptor, version: identity.version };
  const entry = state.entries.find((item) => item.id === descriptor.id && item.settingsVersion === descriptor.settingsVersion);
  const values = new Map(entry?.values.map((item) => [item.key, item.value]));
  return {
    descriptor,
    identity: { id: descriptor.id, version: descriptor.version },
    settingsNamespace: { id: descriptor.id, settingsVersion: descriptor.settingsVersion },
    values: descriptor.settings.map((setting) => ({
      key: setting.key,
      value: values.has(setting.key) ? (values.get(setting.key) ?? null) : setting.default,
    })),
    rejectedSettings: false,
    fallback: null,
  };
}

export function readPublicInterfaceThemeCache(): InterfaceThemeSettingsState | null {
  try {
    const raw = localStorage.getItem(interfaceThemeCacheKey);
    const state = decodeInterfaceThemeCache(raw);
    if (raw && !state) localStorage.removeItem(interfaceThemeCacheKey);
    return state;
  } catch {
    return null;
  }
}

export function rememberPublicInterfaceThemeCache(document: ThemeSettingsDocument): boolean {
  try {
    if (document.legacyMigration !== 'complete') {
      localStorage.removeItem(interfaceThemeCacheKey);
      return true;
    }
    const entries = document.settings.entries.filter((entry) => {
      const descriptor = publicInterfaceThemeDefinitions[entry.id]?.descriptor;
      return descriptor && interfaceThemeSettingsEntryAllows(descriptor, entry);
    });
    const raw = JSON.stringify({ version: 1, savedAt: Date.now(), settings: { formatVersion: 1, entries } });
    if (!decodeInterfaceThemeCache(raw)) return false;
    localStorage.setItem(interfaceThemeCacheKey, raw);
    return localStorage.getItem(interfaceThemeCacheKey) === raw;
  } catch {
    return false;
  }
}

export const interfaceThemeCacheBootstrap = `
const interfaceThemeDefinitions=${JSON.stringify(publicInterfaceThemeDefinitions)};
const interfaceThemeDecode=${decodeInterfaceThemeCache.toString()};
const interfaceThemeResolve=${resolvePublicInterfaceTheme.toString()};
const interfaceThemeProject=${projectInterfaceThemePreferences.toString()};
const interfaceThemeEnvironment=${readInterfaceThemeEnvironment.toString()};
let interfaceThemeCachedSettings=null;
try{interfaceThemeCachedSettings=interfaceThemeDecode(localStorage.getItem(${JSON.stringify(interfaceThemeCacheKey)}),Date.now(),{limit:${interfaceThemeCacheLimit},age:${interfaceThemeCacheAge},definitions:interfaceThemeDefinitions});}catch{}
const interfaceThemeBeforePaint=(base,identity,environment=interfaceThemeEnvironment())=>interfaceThemeProject(base,interfaceThemeResolve(interfaceThemeCachedSettings,identity,interfaceThemeDefinitions),environment);
`;
