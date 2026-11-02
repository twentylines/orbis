import { interfaceThemeSettingsStateSchema, type InterfaceThemeSettingsState } from './interface-theme.js';
import { registeredInterfaceTheme } from './interface-theme-registry.js';
import { silentFrameworkSounds } from './theme-framework-registry.js';

export type LegacyFrameworkPresentation<T> = {
  schema: 'orbis.theme-legacy-adapter.v1';
  identity: { id: string; version: string };
  name: string;
  settingsVersion: number;
  preferences: T;
  namespaces: InterfaceThemeSettingsState;
  uiSupport: 'host-maintained' | 'legacy-undeclared';
  runtimeAvailable: false;
  sounds: ReturnType<typeof silentFrameworkSounds>;
};

// This host adapter never turns a legacy cosmetic pack into a framework package.
export function adaptLegacyThemeFramework<T>(identity: unknown, preferences: T, namespaces: unknown): LegacyFrameworkPresentation<T> {
  const descriptor = registeredInterfaceTheme(identity);
  if (!descriptor || !interfaceThemeSettingsStateSchema.allows(namespaces)) throw new TypeError('Unknown legacy theme or invalid saved namespaces.');
  return {
    schema: 'orbis.theme-legacy-adapter.v1',
    identity: { id: descriptor.id, version: descriptor.version },
    name: descriptor.kind === 'builtin' ? 'Default' : descriptor.name,
    settingsVersion: descriptor.settingsVersion,
    preferences: structuredClone(preferences),
    namespaces: structuredClone(namespaces),
    uiSupport: descriptor.kind === 'builtin' ? 'host-maintained' : 'legacy-undeclared',
    runtimeAvailable: false,
    sounds: silentFrameworkSounds(),
  };
}
