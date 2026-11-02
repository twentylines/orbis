import { createSearchMatcher } from '@runtipi/common/search';
import type { ThemePackManifest, ThemePackSnapshot } from '@runtipi/common/schemas/theme-pack';

export function compareThemeVersions(left: string, right: string) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export function themeVersions(catalogue: ThemePackManifest[], id: string) {
  return catalogue.filter((pack) => pack.id === id).sort((left, right) => compareThemeVersions(left.version, right.version));
}

export function themeCatalogue(catalogue: ThemePackManifest[], search = '') {
  const latest = new Map<string, ThemePackManifest>();
  for (const pack of catalogue) {
    const current = latest.get(pack.id);
    if (!current || compareThemeVersions(pack.version, current.version) > 0) latest.set(pack.id, pack);
  }
  const match = createSearchMatcher(search);
  return [...latest.values()]
    .filter((pack) => match(pack.name, `${pack.description} ${pack.author}`) > 0)
    .sort(
      (left, right) =>
        match(right.name, `${right.description} ${right.author}`) - match(left.name, `${left.description} ${left.author}`) ||
        left.name.localeCompare(right.name),
    );
}

// Cosmetic legacy metadata never grants new-install eligibility.
export function themeStoreVersions(snapshot: ThemePackSnapshot | null): ThemePackManifest[] {
  if (!snapshot) return [];
  const installed = new Set(snapshot.state.installed.map((record) => record.manifest.id));
  const versions = new Map<string, ThemePackManifest>();
  for (const pack of [
    ...snapshot.catalogue.filter((pack) => installed.has(pack.id)),
    ...snapshot.state.installed.flatMap((record) => [...(record.previous ? [record.previous.manifest] : []), record.manifest]),
  ])
    versions.set(`${pack.id}@${pack.version}`, pack);
  return [...versions.values()];
}
export function themeStoreCatalogue(snapshot: ThemePackSnapshot | null, search = '') {
  return themeCatalogue(themeStoreVersions(snapshot), search);
}
export function themeStoreEmptyMessage(snapshot: ThemePackSnapshot | null, search = ''): string | null {
  if (!snapshot || themeStoreCatalogue(snapshot, search).length) return null;
  if (search.trim()) return 'No themes match your search.';
  return snapshot.state.selected ? 'No themes are available.' : 'No themes are available. Default is active.';
}
