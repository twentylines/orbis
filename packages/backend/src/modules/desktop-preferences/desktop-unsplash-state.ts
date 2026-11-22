import { wallpaperUnsplashIdSchema } from '@runtipi/common/schemas/desktop-appearance';
import { type } from 'arktype';

const urlText = type('0 < string <= 2048');
const photoPath = /^\/photo-[A-Za-z0-9-]+$/;
export const unsplashPlaylistLimit = 20;

export function unsplashUrl(value: unknown, host: string, allowedPath: RegExp) {
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

export const unsplashIntervalSchema = type.enumerated(null, 15, 30, 60, 120, 360, 1440);
export const unsplashLibrarySchema = type({
  version: '1',
  photos: photoSchema
    .array()
    .atMostLength(unsplashPlaylistLimit)
    .narrow((photos) => new Set(photos.map(({ id }) => id)).size === photos.length),
  intervalMinutes: unsplashIntervalSchema,
  startedAtMs: '0 <= number.integer <= 9007199254740991',
}).onUndeclaredKey('reject');

export type UnsplashSavedPhoto = typeof photoSchema.infer;
export type UnsplashLibrary = typeof unsplashLibrarySchema.infer;
export type UnsplashInterval = typeof unsplashIntervalSchema.infer;
export type UnsplashAccount = { library: UnsplashLibrary; selectedId: string | null };

export const emptyUnsplashLibrary: UnsplashLibrary = { version: 1, photos: [], intervalMinutes: null, startedAtMs: 0 };

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const referral = (url: URL) => {
  url.search = new URLSearchParams({ utm_source: 'orbis', utm_medium: 'referral' }).toString();
  return url.href;
};

export function readUnsplashPhoto(value: unknown) {
  const photo = record(value);
  const user = record(photo?.user);
  const links = record(photo?.links);
  const images = record(photo?.urls);
  const username = user?.username;
  const id = photo?.id;
  if (!wallpaperUnsplashIdSchema.allows(id) || !wallpaperUnsplashIdSchema.allows(username)) return null;
  const thumbnail = unsplashUrl(images?.small, 'images.unsplash.com', photoPath);
  const full = unsplashUrl(images?.raw, 'images.unsplash.com', photoPath);
  const photoUrl = unsplashUrl(links?.html, 'unsplash.com', /^\/photos\/[A-Za-z0-9_-]+$/);
  const downloadLocation = unsplashUrl(links?.download_location, 'api.unsplash.com', /^\/photos\/[A-Za-z0-9_-]{1,48}\/download$/);
  if (!thumbnail || !full || full.pathname !== thumbnail.pathname || !photoUrl || !downloadLocation) return null;

  // Keep Unsplash's ixid view-tracking parameter when sizing the original image.
  const wallpaperSize = { w: '3840', h: '3840', fit: 'max', q: '90', auto: 'format' };
  for (const [key, size] of Object.entries(wallpaperSize)) full.searchParams.set(key, size);
  full.searchParams.delete('dpr');

  const name = typeof user?.name === 'string' ? user.name.trim() : '';
  const color = typeof photo?.color === 'string' && /^#[0-9a-f]{6}$/i.test(photo.color) ? photo.color : null;
  const result = {
    id,
    imageUrl: full.href,
    thumbnailUrl: thumbnail.href,
    photographer: name.slice(0, 120) || username,
    photographerUrl: referral(new URL(`/@${username}`, 'https://unsplash.com')),
    photoUrl: referral(photoUrl),
    unsplashUrl: referral(new URL('https://unsplash.com')),
    color,
    downloadLocation: downloadLocation.href,
  };
  return photoSchema.allows(result) ? result : null;
}

export const publicUnsplashPhoto = ({ downloadLocation: _downloadLocation, ...photo }: UnsplashSavedPhoto) => photo;

export function currentUnsplashPhoto({ library, selectedId }: UnsplashAccount, now: number) {
  const { photos, intervalMinutes, startedAtMs } = library;
  const start = photos.findIndex(({ id }) => id === selectedId);
  if (start < 0) return { photo: null, nextChangeAtMs: null };
  if (intervalMinutes === null || photos.length < 2) return { photo: photos[start] ?? null, nextChangeAtMs: null };
  const duration = intervalMinutes * 60_000;
  const periods = Math.max(0, Math.floor((now - startedAtMs) / duration));
  return { photo: photos[(start + periods) % photos.length] ?? null, nextChangeAtMs: startedAtMs + (periods + 1) * duration };
}
