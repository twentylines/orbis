import { interfaceThemeHostAccessibilitySchema, type InterfaceThemeHostAccessibility } from '@runtipi/common/schemas/interface-theme';
import {
  resolveInterfaceThemeSettings,
  interfaceThemeCompatibility,
  type InterfaceThemeIncompatibility,
  type ResolvedInterfaceThemeSettings,
} from '@runtipi/common/schemas/interface-theme-resolution';
export { interfaceThemeCompatibility, type InterfaceThemeIncompatibility };

export type ResolvedInterfaceTheme = ResolvedInterfaceThemeSettings & { accessibility: InterfaceThemeHostAccessibility };

export function resolveInterfaceTheme(requested: unknown, state: unknown, hostAccessibility: unknown): ResolvedInterfaceTheme {
  // Invalid host data uses conservative recovery values; packages never replace this channel.
  const accessibility: InterfaceThemeHostAccessibility = interfaceThemeHostAccessibilitySchema.allows(hostAccessibility)
    ? { ...hostAccessibility }
    : { reducedMotion: true, reducedTransparency: true, forcedColours: true, textScale: 100, mutedSounds: true };
  return { ...resolveInterfaceThemeSettings(requested, state), accessibility };
}
