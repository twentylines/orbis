import { createContext, useContext, useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  if (!listeners.size) document.addEventListener('visibilitychange', notify);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) document.removeEventListener('visibilitychange', notify);
  };
};
const visible = () => document.visibilityState !== 'hidden';
const serverVisible = () => true;

export const WindowVisibilityContext = createContext(true);
export const useWindowVisible = () => {
  const windowVisible = useContext(WindowVisibilityContext);
  const documentVisible = useSyncExternalStore(subscribe, visible, serverVisible);
  return windowVisible && documentVisible;
};
