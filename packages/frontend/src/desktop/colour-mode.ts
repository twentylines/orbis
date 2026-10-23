import { useSyncExternalStore } from 'react';

export type ColourMode = 'light' | 'dark' | 'system';
export type ResolvedColourMode = Exclude<ColourMode, 'system'>;

export function resolveColourMode(mode: ColourMode, systemDark: boolean): ResolvedColourMode {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}

const systemQuery = () => {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  } catch {
    return null;
  }
};
const lightMode = (): ResolvedColourMode => 'light';
export const readSystemColourMode = (): ResolvedColourMode => resolveColourMode('system', systemQuery()?.matches ?? false);
const noSubscription = () => () => undefined;
const subscribe = (onChange: () => void) => {
  const query = systemQuery();
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
};

export function useResolvedColourMode(mode: ColourMode): ResolvedColourMode {
  const resolved = useSyncExternalStore(
    mode === 'system' ? subscribe : noSubscription,
    mode === 'system' ? readSystemColourMode : lightMode,
    lightMode,
  );
  return mode === 'system' ? resolved : mode;
}
