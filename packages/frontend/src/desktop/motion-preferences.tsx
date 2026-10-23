import { MotionConfig, useReducedMotion as useSystemReducedMotion } from 'framer-motion';
import { createContext, useContext, useSyncExternalStore, type PropsWithChildren } from 'react';

const ReducedMotion = createContext(false);

export function MotionPreferences({ reduced, children }: PropsWithChildren<{ reduced: boolean }>) {
  return (
    <ReducedMotion.Provider value={reduced}>
      <MotionConfig reducedMotion={reduced ? 'always' : 'user'}>{children}</MotionConfig>
    </ReducedMotion.Provider>
  );
}

export function useReducedMotion() {
  const system = useSystemReducedMotion();
  return useContext(ReducedMotion) || system;
}

const transparencyQuery = () => {
  try {
    return typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-transparency: reduce)') : null;
  } catch {
    return null;
  }
};
const subscribeTransparency = (change: () => void) => {
  const query = transparencyQuery();
  query?.addEventListener('change', change);
  return () => query?.removeEventListener('change', change);
};
export function useReducedTransparency() {
  return useSyncExternalStore(
    subscribeTransparency,
    () => transparencyQuery()?.matches ?? false,
    () => false,
  );
}
