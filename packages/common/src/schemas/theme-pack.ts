import { type } from 'arktype';

const text = type('string > 0 & string <= 240').narrow(
  (value) => ![...value].some((character) => character.charCodeAt(0) < 32 || '<>'.includes(character)),
);
export const themePackIdSchema = type('string').narrow((value) => /^[a-z][a-z0-9-]{2,47}$/.test(value));
export const themePackVersionSchema = type('string').narrow((value) => /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(value));
const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
const colour = type('string').narrow((value) => /^#[a-f0-9]{6}$/i.test(value));
const source = type('string <= 300').narrow((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
});
export const themePackPaletteSchema = type({
  ink: colour,
  muted: colour,
  surface: colour,
  chrome: colour,
  chromeInk: colour,
  panel: colour,
  accent: colour,
  action: colour,
  positive: colour,
  negative: colour,
  warning: colour,
  info: colour,
  tint: colour,
}).onUndeclaredKey('reject');
export const themePackAssetSchema = type({
  path: type('string').narrow((value) => /^[a-z][a-z0-9-]{0,47}\.webp$/.test(value)),
  sha256: hash,
  mime: "'image/webp'",
  bytes: '1 <= number.integer <= 4194304',
  width: '1 <= number.integer <= 4096',
  height: '1 <= number.integer <= 4096',
})
  .onUndeclaredKey('reject')
  .narrow((asset) => asset.width * asset.height <= 8_000_000);
export const themePackManifestSchema = type({
  formatVersion: '1',
  catalogue: "'orbis-bundled-v1'",
  id: themePackIdSchema,
  version: themePackVersionSchema,
  name: text,
  description: text,
  author: text,
  source,
  license: type({ name: text, url: source }).onUndeclaredKey('reject'),
  fallbackPreset: type.enumerated('frost', 'graphite', 'forest', 'stone', 'ocean', 'blush'),
  light: themePackPaletteSchema,
  dark: themePackPaletteSchema,
  wallpaper: hash,
  assets: themePackAssetSchema.array().narrow((items) => items.length === 1),
  treatment: type({
    typography: type.enumerated('source-sans', 'system'),
    corners: type.enumerated('soft', 'crisp'),
    material: type.enumerated('mist', 'clear'),
    icons: type.enumerated('fine', 'regular'),
    controls: type.enumerated('quiet', 'defined'),
    charts: type.enumerated('soft', 'defined'),
    menus: type.enumerated('flat', 'raised'),
    motion: type.enumerated('calm', 'quick'),
  }).onUndeclaredKey('reject'),
})
  .onUndeclaredKey('reject')
  .narrow((pack) => pack.assets[0]?.sha256 === pack.wallpaper);
export type ThemePackManifest = typeof themePackManifestSchema.infer;
export const themePackReferenceSchema = type({ id: themePackIdSchema, version: themePackVersionSchema }).onUndeclaredKey('reject');
export type ThemePackReference = typeof themePackReferenceSchema.infer;
const versionRecord = type({ manifest: themePackManifestSchema, digest: hash }).onUndeclaredKey('reject');
const timestamp = type('string').narrow((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)));
export const themePackInstallationSchema = type({
  manifest: themePackManifestSchema,
  digest: hash,
  installedAt: timestamp,
  updatedAt: timestamp,
  previous: versionRecord.or('null'),
})
  .onUndeclaredKey('reject')
  .narrow(
    (record) =>
      !record.previous || (record.previous.manifest.id === record.manifest.id && record.previous.manifest.version !== record.manifest.version),
  );
export type ThemePackInstallation = typeof themePackInstallationSchema.infer;
export const themePackStateSchema = type({
  formatVersion: '1',
  selected: themePackReferenceSchema.or('null'),
  installed: themePackInstallationSchema
    .array()
    .narrow((items) => items.length <= 12 && new Set(items.map((item) => item.manifest.id)).size === items.length),
})
  .onUndeclaredKey('reject')
  .narrow(
    (state) =>
      !state.selected || state.installed.some((item) => item.manifest.id === state.selected?.id && item.manifest.version === state.selected.version),
  );
export type ThemePackState = typeof themePackStateSchema.infer;
export const themePackSnapshotSchema = type({
  state: themePackStateSchema,
  catalogue: themePackManifestSchema
    .array()
    .narrow((items) => items.length <= 24 && new Set(items.map((item) => `${item.id}@${item.version}`)).size === items.length),
}).onUndeclaredKey('reject');
export type ThemePackSnapshot = typeof themePackSnapshotSchema.infer;
