import { themePackManifestSchema, type ThemePackManifest } from '@runtipi/common/schemas/theme-pack';
import type { DesktopAppearance } from '@runtipi/common/schemas/desktop-appearance';
import { isThemePackAppearance, publicThemePackWallpaper, type ThemePackAppearance } from './theme-pack-cache';

export function themePackAppearance(pack: ThemePackAppearance | null, personal: DesktopAppearance): DesktopAppearance {
  if (!pack) return personal;
  const mist = pack.treatment.material === 'mist';
  return {
    ...personal,
    surfaceOpacity: personal.surfaceOpacity ?? (mist ? 96 : 98),
    chromeOpacity: personal.chromeOpacity ?? (mist ? 90 : 96),
    glassBlur: personal.glassBlur ?? (mist ? 28 : 12),
    chromeBlur: personal.chromeBlur ?? (mist ? 32 : 16),
  };
}

export function themePackAssetUrl(pack: ThemePackManifest) {
  return `/api/theme-packs/${pack.id}/${pack.version}/assets/${pack.wallpaper}`;
}

export function applyThemePackRuntime(value: unknown, mode: 'light' | 'dark', useWallpaper: boolean) {
  const candidate = themePackManifestSchema.allows(value)
    ? (({ id, version, name, light, dark, wallpaper, treatment }) => ({ id, version, name, light, dark, wallpaper, treatment }))(value)
    : value;
  const pack = isThemePackAppearance(candidate) ? candidate : null;
  applyThemePackAppearanceRuntime(pack, mode, useWallpaper, pack ? publicThemePackWallpaper(pack) : null);
}

export function applyThemePackAppearanceRuntime(
  pack: ThemePackAppearance | null,
  mode: 'light' | 'dark',
  useWallpaper: boolean,
  wallpaper: string | null,
) {
  const paletteNames = {
    ink: 'ink',
    muted: 'base-muted',
    surface: 'base-surface',
    chrome: 'base-chrome',
    chromeInk: 'chrome-ink',
    panel: 'base-panel-dark',
    accent: 'base-accent',
    action: 'base-action',
    positive: 'base-positive',
    negative: 'base-negative',
    warning: 'base-warning',
    info: 'base-info',
    tint: 'preset-tint',
  } as const;
  const extraProperties = [
    '--desktop-line',
    '--desktop-edge',
    '--desktop-highlight',
    '--desktop-base-action-rgb',
    '--desktop-base-action-ink',
    '--desktop-base-focus',
    '--desktop-base-chrome-rgb',
    '--workspace-heading-ink',
    '--orbis-pack-wallpaper',
    '--orbis-pack-font',
    '--orbis-pack-radius',
    '--orbis-pack-icon-stroke',
    '--orbis-pack-duration',
    '--orbis-pack-control-border',
    '--orbis-pack-chart-alpha',
    '--orbis-pack-menu-shadow',
  ];

  const root = document.documentElement;
  for (const token of Object.values(paletteNames)) root.style.removeProperty(`--desktop-${token}`);
  for (const property of extraProperties) root.style.removeProperty(property);
  delete root.dataset.orbisThemePack;
  delete root.dataset.orbisPackWallpaper;
  if (!pack) return;
  const palette = pack[mode];
  for (const [name, token] of Object.entries(paletteNames)) root.style.setProperty(`--desktop-${token}`, palette[name as keyof typeof palette]);
  const channels = (hex: string) => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(', ');
  root.style.setProperty('--desktop-line', `color-mix(in srgb, ${palette.ink} 18%, transparent)`);
  root.style.setProperty('--desktop-edge', `color-mix(in srgb, ${palette.tint} 25%, transparent)`);
  root.style.setProperty('--desktop-highlight', 'transparent');
  root.style.setProperty('--desktop-base-action-rgb', channels(palette.action));
  root.style.setProperty('--desktop-base-chrome-rgb', channels(palette.chrome));
  root.style.setProperty('--desktop-base-action-ink', '#ffffff');
  root.style.setProperty('--desktop-base-focus', palette.accent);
  root.style.setProperty('--workspace-heading-ink', palette.ink);
  if (wallpaper) root.style.setProperty('--orbis-pack-wallpaper', `url("${wallpaper}")`);
  root.style.setProperty(
    '--orbis-pack-font',
    pack.treatment.typography === 'system'
      ? '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      : '"Source Sans 3", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  );
  root.style.setProperty('--orbis-pack-radius', pack.treatment.corners === 'soft' ? '16px' : '8px');
  root.style.setProperty('--orbis-pack-icon-stroke', pack.treatment.icons === 'fine' ? '1.5' : '2');
  root.style.setProperty('--orbis-pack-duration', pack.treatment.motion === 'calm' ? '240ms' : '140ms');
  root.style.setProperty('--orbis-pack-control-border', pack.treatment.controls === 'defined' ? 'var(--desktop-accent)' : 'var(--desktop-line)');
  root.style.setProperty('--orbis-pack-chart-alpha', pack.treatment.charts === 'defined' ? '30%' : '16%');
  root.style.setProperty('--orbis-pack-menu-shadow', pack.treatment.menus === 'raised' ? '0 12px 32px rgb(0 0 0 / 0.18)' : 'none');
  root.dataset.orbisThemePack = `${pack.id}@${pack.version}`;
  root.dataset.orbisPackWallpaper = String(useWallpaper && Boolean(wallpaper));
}
