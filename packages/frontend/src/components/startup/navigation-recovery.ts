const intentKey = 'orbis-navigation-intent-v1';
type NavigationStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function localDestination(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 2048 &&
    /^\/(?![/\\])/.test(value) &&
    [...value].every((character) => character.charCodeAt(0) > 32 && character !== '\\')
  );
}

export function rememberNavigation(storage: NavigationStorage, from: string, to: string, now: number) {
  if (!localDestination(from) || !localDestination(to) || from === to || !Number.isFinite(now)) return;
  try {
    storage.setItem(intentKey, JSON.stringify({ from, to, at: now }));
  } catch {
    // Navigation itself remains available without browser storage.
  }
}

export function clearNavigation(storage: NavigationStorage) {
  try {
    storage.removeItem(intentKey);
  } catch {
    // This cache is optional.
  }
}

export function recoverNavigation(storage: NavigationStorage, current: string, now: number, reloaded: boolean): string | null {
  try {
    const raw = storage.getItem(intentKey);
    storage.removeItem(intentKey);
    if (!raw || raw.length > 8192 || !reloaded) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !('from' in value) || !('to' in value) || !('at' in value)) return null;
    const age = typeof value.at === 'number' ? now - value.at : Number.NaN;
    if (!Number.isFinite(age) || age < 0 || age > 30_000 || value.from !== current || !localDestination(value.to) || value.to === current)
      return null;
    return value.to;
  } catch {
    return null;
  }
}
