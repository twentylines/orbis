import { themePackManifestSchema } from '@runtipi/common/schemas/theme-pack';
import type { InterfaceThemeDescriptor } from '@runtipi/common/schemas/interface-theme';
import {
  legacyThemeDescriptor,
  legacyThemeIdentities,
  legacyThemeVersions,
  orbisThemeSettings,
} from '@runtipi/common/schemas/interface-theme-registry';
export { legacyThemeDescriptor, legacyThemeIdentities, legacyThemeVersions, orbisThemeSettings };

// Adapt metadata only; the existing installer remains responsible for manifest and asset integrity.
export function adaptLegacyThemeManifest(value: unknown): InterfaceThemeDescriptor | null {
  return themePackManifestSchema.allows(value) ? legacyThemeDescriptor(value.id, value.version) : null;
}
