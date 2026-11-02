import { type } from 'arktype';
export const historicalIconLimits = {
  icons: 512,
  imageBytes: 1024 ** 2,
  totalImageBytes: 16 * 1024 ** 2,
  bundleBytes: 24 * 1024 ** 2,
  dimension: 1024,
} as const;
const hash = type('string').narrow((value) => /^[a-f0-9]{64}$/.test(value));
export const historicalIconSchema = type({
  urn: type('string <= 180').narrow((value) => /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(value)),
  identity: hash,
  bytes: `1 <= number.integer <= ${historicalIconLimits.imageBytes}`,
  mime: "'image/png' | 'image/jpeg' | 'image/webp'",
  width: `1 <= number.integer <= ${historicalIconLimits.dimension}`,
  height: `1 <= number.integer <= ${historicalIconLimits.dimension}`,
  source: "'captured-installed' | 'captured-repository'",
}).onUndeclaredKey('reject');
const icons = historicalIconSchema
  .array()
  .atMostLength(historicalIconLimits.icons)
  .narrow(
    (items) =>
      new Set(items.map((item) => item.urn)).size === items.length &&
      items.reduce((total, item) => total + item.bytes, 0) <= historicalIconLimits.totalImageBytes,
  );
export const historicalIconsAssetSchema = type({
  available: 'true',
  identity: hash,
  cipherSha256: hash,
  bytes: `1 <= number.integer <= ${historicalIconLimits.bundleBytes}`,
  icons,
}).onUndeclaredKey('reject');
export const historicalIconsPayloadSchema = type({
  version: '1',
  icons: historicalIconSchema
    .merge({
      data: type(`string <= ${Math.ceil(historicalIconLimits.imageBytes / 3) * 4}`).narrow((value) =>
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
      ),
    })
    .array()
    .atMostLength(historicalIconLimits.icons),
})
  .onUndeclaredKey('reject')
  .narrow(
    (value) =>
      new Set(value.icons.map((item) => item.urn)).size === value.icons.length &&
      value.icons.reduce((total, item) => total + item.bytes, 0) <= historicalIconLimits.totalImageBytes,
  );
export type HistoricalIcon = typeof historicalIconSchema.infer;
export type HistoricalIconsAsset = typeof historicalIconsAssetSchema.infer;
