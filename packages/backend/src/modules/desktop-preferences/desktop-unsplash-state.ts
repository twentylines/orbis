import { wallpaperUnsplashIdSchema } from '@runtipi/common/schemas/desktop-appearance';
import { type } from 'arktype';

const urlText = type('0 < string <= 2048');
const photoPath = /^\/photo-[A-Za-z0-9-]+$/;
const unsplashPlaylistLimit = 20;

function unsplashUrl(value: unknown, host: string, allowedPath: RegExp) {
  if (!urlText.allows(value)) return null;
  try {
    const url = new URL(value);
    if (url.origin !== `https://${host}` || url.username || url.password || url.hash || !allowedPath.test(url.pathname)) return null;
    return url;
  } catch {
    return null;
  }
}

const imageUrl = urlText.narrow((value) => unsplashUrl(value, 'images.unsplash.com', photoPath) !== null);
const attributionUrl = urlText.narrow((value) => {
  const url = unsplashUrl(value, 'unsplash.com', /^\/(?:@?[A-Za-z0-9_-]+|photos\/[A-Za-z0-9_-]+)?$/);
  return url?.searchParams.get('utm_source') === 'orbis' && url.searchParams.get('utm_medium') === 'referral';
});
const downloadUrl = urlText.narrow((value) => unsplashUrl(value, 'api.unsplash.com', /^\/photos\/[A-Za-z0-9_-]{1,48}\/download$/) !== null);
const photoSchema = type({
  id: wallpaperUnsplashIdSchema,
  imageUrl,
  thumbnailUrl: imageUrl,
  photographer: '0 < string <= 120',
  photographerUrl: attributionUrl,
  photoUrl: attributionUrl,
  unsplashUrl: attributionUrl,
  color: type('string | null').narrow((value) => value === null || /^#[0-9a-f]{6}$/i.test(value)),
  downloadLocation: downloadUrl,
})
  .onUndeclaredKey('reject')
  .narrow((photo) => new URL(photo.downloadLocation).pathname === `/photos/${photo.id}/download`);

const unsplashIntervalSchema = type.enumerated(null, 15, 30, 60, 120, 360, 1440);
export const unsplashLibrarySchema = type({
  version: '1',
  photos: photoSchema
    .array()
    .atMostLength(unsplashPlaylistLimit)
    .narrow((photos) => new Set(photos.map(({ id }) => id)).size === photos.length),
  intervalMinutes: unsplashIntervalSchema,
  startedAtMs: '0 <= number.integer <= 9007199254740991',
}).onUndeclaredKey('reject');

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
