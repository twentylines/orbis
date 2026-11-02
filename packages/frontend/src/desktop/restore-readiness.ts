import type { CachedAppearance } from './appearance-cache';

export function restoredPreferencesState(restore: boolean, authenticated: boolean, serverReady: boolean, failed: boolean) {
  return !restore || !authenticated || serverReady ? 'normal' : failed ? 'error' : 'waiting';
}
let verifiedAppearance: CachedAppearance | null = null;
const listeners = new Set<() => void>();
export const readServerAppearance = () => verifiedAppearance;
export const serverAppearanceSnapshot = () => null;
export function subscribeServerAppearance(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function publishServerAppearance(appearance: CachedAppearance | null) {
  verifiedAppearance = appearance;
  for (const listener of listeners) listener();
}
