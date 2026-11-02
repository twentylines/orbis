import { validateThemeFrameworkCatalogue, type ThemeFrameworkCatalogue } from '@runtipi/common/schemas/theme-framework-catalogue';

export type FrameworkCatalogueResponse = {
  status: 'ready' | 'stale' | 'unavailable';
  catalogue: ThemeFrameworkCatalogue | null;
  checkedAt: string | null;
  runtimeAvailable: boolean;
};

export async function readFrameworkCatalogue(signal: AbortSignal): Promise<FrameworkCatalogueResponse> {
  const response = await fetch('/api/theme-framework/catalogue', {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok)
    throw new Error(response.status === 403 ? 'Theme discovery requires an operator account.' : 'Theme catalogue could not be loaded.');
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object') throw new Error('Unsupported theme catalogue.');
  const raw = value as Record<string, unknown>;
  if (
    !['ready', 'stale', 'unavailable'].includes(String(raw.status)) ||
    typeof raw.runtimeAvailable !== 'boolean' ||
    !(raw.checkedAt === null || (typeof raw.checkedAt === 'string' && Number.isFinite(Date.parse(raw.checkedAt))))
  )
    throw new Error('Unsupported theme catalogue.');
  if ((raw.status === 'unavailable') !== (raw.catalogue === null)) throw new Error('Unsupported theme catalogue.');
  let catalogue: ThemeFrameworkCatalogue | null;
  try {
    catalogue = raw.catalogue === null ? null : validateThemeFrameworkCatalogue(raw.catalogue);
  } catch {
    throw new Error('Unsupported theme catalogue.');
  }
  return {
    status: raw.status as FrameworkCatalogueResponse['status'],
    catalogue,
    checkedAt: raw.checkedAt as string | null,
    runtimeAvailable: raw.runtimeAvailable,
  };
}

export function frameworkCatalogueNotice(data: FrameworkCatalogueResponse | null, error: string): string | null {
  if (error) return data?.catalogue ? `${error} Showing the last known catalogue.` : error;
  if (!data) return 'Loading theme catalogue…';
  if (data.status === 'stale') return 'Showing an older theme catalogue.';
  if (data.status === 'unavailable') return 'Theme catalogue is unavailable.';
  return null;
}
