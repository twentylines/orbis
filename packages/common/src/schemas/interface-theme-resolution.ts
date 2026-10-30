import {
  interfaceThemeDescriptorSchema,
  interfaceThemeIdentitySchema,
  interfaceThemeSettingsEntryAllows,
  interfaceThemeSettingsStateSchema,
  type InterfaceThemeCapability,
  type InterfaceThemeDescriptor,
  type InterfaceThemeIdentity,
  type InterfaceThemeValue,
} from './interface-theme.js';
import { builtinInterfaceTheme, registeredInterfaceTheme } from './interface-theme-registry.js';

const supportedCapabilities: readonly InterfaceThemeCapability[] = [
  'palette',
  'material',
  'wallpaper',
  'typography',
  'icon-treatment',
  'control-treatment',
  'chart-treatment',
  'menu-treatment',
  'motion-treatment',
];
export type InterfaceThemeIncompatibility = 'invalid-descriptor' | 'host-api' | 'capability' | 'implementation';

export function interfaceThemeCompatibility(value: unknown): InterfaceThemeIncompatibility | null {
  if (!interfaceThemeDescriptorSchema.allows(value)) return 'invalid-descriptor';
  if (value.hostApiVersion !== 1) return 'host-api';
  if (value.capabilities.some((capability) => !supportedCapabilities.includes(capability))) return 'capability';
  if (
    !(
      (value.kind === 'builtin' && value.implementation === 'orbis-v1') ||
      (value.kind === 'legacy-pack' && value.implementation === 'orbis-legacy-v1')
    )
  )
    return 'implementation';
  return null;
}

export type ResolvedInterfaceThemeSettings = {
  descriptor: InterfaceThemeDescriptor;
  identity: InterfaceThemeIdentity;
  settingsNamespace: { id: string; settingsVersion: number };
  values: { key: string; value: InterfaceThemeValue }[];
  rejectedSettings: boolean;
  fallback: 'invalid-identity' | 'unavailable' | InterfaceThemeIncompatibility | null;
};

export function resolveInterfaceThemeSettings(requested: unknown, state: unknown): ResolvedInterfaceThemeSettings {
  let fallback: ResolvedInterfaceThemeSettings['fallback'] = null;
  let descriptor = builtinInterfaceTheme;
  if (requested !== null) {
    if (interfaceThemeIdentitySchema.allows(requested)) {
      const candidate = registeredInterfaceTheme(requested);
      if (candidate) {
        fallback = interfaceThemeCompatibility(candidate);
        if (!fallback) descriptor = candidate;
      } else fallback = 'unavailable';
    } else fallback = 'invalid-identity';
  }
  const validState = interfaceThemeSettingsStateSchema.allows(state);
  const entry = validState
    ? state.entries.find((item) => item.id === descriptor.id && item.settingsVersion === descriptor.settingsVersion)
    : undefined;
  const accepted = entry !== undefined && interfaceThemeSettingsEntryAllows(descriptor, entry);
  const overrides = new Map(accepted ? entry.values.map((item) => [item.key, item.value] as const) : []);
  return {
    descriptor,
    identity: { id: descriptor.id, version: descriptor.version },
    settingsNamespace: { id: descriptor.id, settingsVersion: descriptor.settingsVersion },
    values: descriptor.settings.map((setting) => ({
      key: setting.key,
      value: overrides.has(setting.key) ? (overrides.get(setting.key) ?? null) : setting.default,
    })),
    rejectedSettings: !validState || (entry !== undefined && !accepted),
    fallback,
  };
}
