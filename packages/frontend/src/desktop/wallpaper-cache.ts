export const wallpaperFileLimit = 32 * 1024 * 1024;
export const wallpaperCacheEvent = 'orbis-wallpaper-cache-changed';
const databaseName = 'orbis-browser-wallpaper';
const storeName = 'images';
type CachedWallpaper = { hash: string; blob: Blob };
export const wallpaperUrl = (hash: string, revision = 0) => `/api/desktop-preferences/wallpaper?version=${hash}&refresh=${revision}`;

export function isCachedWallpaper(value: unknown): value is CachedWallpaper {
  if (!value || typeof value !== 'object' || !('hash' in value) || !('blob' in value)) return false;
  return (
    typeof value.hash === 'string' &&
    /^[a-f0-9]{64}$/.test(value.hash) &&
    value.blob instanceof Blob &&
    value.blob.size > 0 &&
    value.blob.size <= wallpaperFileLimit &&
    ['image/png', 'image/jpeg', 'image/webp'].includes(value.blob.type)
  );
}

async function access(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
  if (typeof indexedDB === 'undefined') return null;
  return new Promise((resolve) => {
    let database: IDBDatabase | undefined;
    let settled = false;
    const finish = (value: unknown = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      database?.close();
      resolve(value);
    };
    const timeout = setTimeout(() => finish(), 3000);
    let open: IDBOpenDBRequest;
    try {
      open = indexedDB.open(databaseName, 1);
    } catch {
      finish();
      return;
    }
    open.onupgradeneeded = () => open.result.createObjectStore(storeName);
    open.onerror = open.onblocked = () => finish();
    open.onsuccess = () => {
      database = open.result;
      if (settled) return database.close();
      try {
        const transaction = database.transaction(storeName, mode);
        const request = operation(transaction.objectStore(storeName));
        transaction.oncomplete = () => finish(mode === 'readonly' ? request.result : true);
        transaction.onerror = transaction.onabort = () => finish();
      } catch {
        finish();
      }
    };
  });
}

export async function readBrowserWallpaper(hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  const value = await access('readonly', (store) => store.get('last'));
  return isCachedWallpaper(value) && value.hash === hash ? value.blob : null;
}

export async function readWallpaperImage(hash: string, authenticated: boolean, revision: number, signal: AbortSignal) {
  const cached = await readBrowserWallpaper(hash);
  signal.throwIfAborted();
  if (cached) return { blob: cached, cached: true };
  if (!authenticated) return null;
  const response = await fetch(wallpaperUrl(hash, revision), { credentials: 'include', cache: 'no-store', signal });
  if (!response.ok) throw new Error('Wallpaper unavailable');
  const blob = await response.blob();
  if (!isCachedWallpaper({ hash, blob })) throw new Error('Invalid wallpaper');
  return { blob, cached: false };
}

export async function rememberBrowserWallpaper(hash: string, blob: Blob) {
  if (!isCachedWallpaper({ hash, blob })) return false;
  const saved = (await access('readwrite', (store) => store.put({ hash, blob }, 'last'))) === true;
  if (saved && typeof window !== 'undefined') window.dispatchEvent(new Event(wallpaperCacheEvent));
  return saved;
}

export async function forgetBrowserWallpaper() {
  const removed = (await access('readwrite', (store) => store.delete('last'))) === true;
  if (removed && typeof window !== 'undefined') window.dispatchEvent(new Event(wallpaperCacheEvent));
}
