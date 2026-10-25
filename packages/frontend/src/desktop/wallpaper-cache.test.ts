/// <reference types="bun" />
import { afterEach, describe, expect, test } from 'bun:test';
import {
  forgetBrowserWallpaper,
  isCachedWallpaper,
  readBrowserWallpaper,
  readWallpaperImage,
  rememberBrowserWallpaper,
  wallpaperUrl,
} from './wallpaper-cache';

const original = globalThis.indexedDB;
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.indexedDB = original;
  globalThis.fetch = originalFetch;
});
function storage() {
  const records = new Map<string, unknown>();
  let closes = 0;
  globalThis.indexedDB = {
    open: () => {
      const open = {
        result: {
          close: () => {
            closes += 1;
          },
          transaction: () => {
            const transaction = {
              oncomplete: () => {},
              objectStore: () => ({
                get: (key: string) => request(records.get(key)),
                put: (value: unknown, key: string) => {
                  records.set(key, value);
                  return request(key);
                },
                delete: (key: string) => {
                  records.delete(key);
                  return request(undefined);
                },
              }),
            };
            const request = (result: unknown) => {
              queueMicrotask(() => transaction.oncomplete());
              return { result };
            };
            return transaction;
          },
        },
        onsuccess: () => {},
      };
      queueMicrotask(() => open.onsuccess());
      return open;
    },
  } as unknown as IDBFactory;
  return { records, closes: () => closes };
}
describe('this browser’s last wallpaper', () => {
  test('stores one Blob, replaces it, matches its hash and closes each database connection', async () => {
    const store = storage();
    const first = new Blob(['first'], { type: 'image/png' });
    const second = new Blob(['second'], { type: 'image/webp' });
    expect(await rememberBrowserWallpaper('a'.repeat(64), first)).toBe(true);
    expect(await readBrowserWallpaper('a'.repeat(64))).toBe(first);
    expect(await readBrowserWallpaper('b'.repeat(64))).toBeNull();
    expect(await rememberBrowserWallpaper('b'.repeat(64), second)).toBe(true);
    expect(store.records.size).toBe(1);
    expect(await readBrowserWallpaper('a'.repeat(64))).toBeNull();
    expect(await readBrowserWallpaper('b'.repeat(64))).toBe(second);
    await forgetBrowserWallpaper();
    expect(store.records.size).toBe(0);
    expect(store.closes()).toBe(7);
  });
  test('rejects arbitrary paths, empty bytes and non-image data', async () => {
    const store = storage();
    expect(isCachedWallpaper({ hash: 'a'.repeat(64), blob: new Blob(['html'], { type: 'text/html' }) })).toBe(false);
    expect(isCachedWallpaper({ hash: 'a'.repeat(64), blob: new Blob([], { type: 'image/png' }) })).toBe(false);
    expect(await rememberBrowserWallpaper('/private/image', new Blob(['png'], { type: 'image/png' }))).toBe(false);
    expect(await readBrowserWallpaper('https://example.test/image')).toBeNull();
    expect(store.records.size).toBe(0);
    expect(store.closes()).toBe(0);
  });
  test('a fresh or storage-blocked browser receives no private image', async () => {
    storage();
    expect(await readBrowserWallpaper('a'.repeat(64))).toBeNull();
    globalThis.indexedDB = {
      open: () => {
        throw new Error('Storage denied');
      },
    } as unknown as IDBFactory;
    expect(await readBrowserWallpaper('a'.repeat(64))).toBeNull();
    expect(await rememberBrowserWallpaper('a'.repeat(64), new Blob(['png'], { type: 'image/png' }))).toBe(false);
  });
  test('anonymous pages use local bytes only; authenticated downloads keep credentials and are reusable offline', async () => {
    storage();
    const calls: [string, RequestInit | undefined][] = [];
    const blob = new Blob(['original'], { type: 'image/png' });
    globalThis.fetch = (async (url: string, options?: RequestInit) => {
      calls.push([url, options]);
      return new Response(blob, { headers: { 'Content-Type': 'image/png' } });
    }) as typeof fetch;
    const signal = new AbortController().signal;
    const hash = 'a'.repeat(64);
    expect(await readWallpaperImage(hash, false, 0, signal)).toBeNull();
    expect(calls.length).toBe(0);
    const downloaded = await readWallpaperImage(hash, true, 3, signal);
    expect(downloaded?.cached).toBe(false);
    expect(calls).toEqual([[wallpaperUrl(hash, 3), { credentials: 'include', cache: 'no-store', signal }]]);
    await rememberBrowserWallpaper(hash, downloaded?.blob as Blob);
    const anonymous = await readWallpaperImage(hash, false, 0, signal);
    expect(await anonymous?.blob.text()).toBe('original');
    expect((await readWallpaperImage(hash, true, 0, signal))?.cached).toBe(true);
    expect(calls.length).toBe(1);
  });
});
