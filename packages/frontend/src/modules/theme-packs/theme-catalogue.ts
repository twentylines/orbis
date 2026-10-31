import { createSearchMatcher } from '@runtipi/common/types';
import type { ThemePackManifest } from '@runtipi/common/schemas/theme-pack';

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
