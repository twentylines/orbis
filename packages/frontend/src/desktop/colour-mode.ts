import { useSyncExternalStore } from 'react';

export type ColourMode = 'light' | 'dark' | 'system';
export type ResolvedColourMode = Exclude<ColourMode, 'system'>;

const systemQuery = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const lightMode = (): ResolvedColourMode => 'light';
const systemMode = (): ResolvedColourMode => (systemQuery()?.matches ? 'dark' : 'light');
const noSubscription = () => () => undefined;
const subscribe = (onChange: () => void) => {
  const query = systemQuery();
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
};

export function useResolvedColourMode(mode: ColourMode): ResolvedColourMode {
  const resolved = useSyncExternalStore(mode === 'system' ? subscribe : noSubscription, mode === 'system' ? systemMode : lightMode, lightMode);
  return mode === 'system' ? resolved : mode;
}
