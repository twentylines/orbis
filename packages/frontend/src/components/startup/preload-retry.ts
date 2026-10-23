const retryKey = 'orbis-preload-retry-v1';

export function claimPreloadRetry(storage: Pick<Storage, 'getItem' | 'setItem'>, now: number) {
  try {
    const last = Number(storage.getItem(retryKey));
    if (last > 0 && now - last < 60_000) return false;
    storage.setItem(retryKey, String(now));
    return storage.getItem(retryKey) === String(now);
  } catch {
    return false;
  }
}
