export type CatalogueCompatibility = {
  catalog_format?: 'orbis' | 'umbrel';
  compatibility?: { supported: boolean; reasons: string[]; requires_auth: boolean };
  gallery?: string[];
  release_notes?: string;
};

export function catalogueInstallAllowed(app: { available: boolean; deprecated: boolean } & CatalogueCompatibility) {
  return app.available && !app.deprecated && app.compatibility?.supported !== false;
}

export function catalogueInstallDefaults(app: CatalogueCompatibility, initialValues?: Record<string, unknown>) {
  if (!app.compatibility?.requires_auth) return initialValues;
  return {
    ...initialValues,
    enableAuth: true,
    openPort: false,
    exposedLocal: Boolean(initialValues?.exposedLocal || !initialValues?.exposed),
  };
}

export function catalogueGallery(app: CatalogueCompatibility): string[] {
  return [...new Set(app.gallery ?? [])]
    .filter((url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
      } catch {
        return false;
      }
    })
    .slice(0, 8);
}
