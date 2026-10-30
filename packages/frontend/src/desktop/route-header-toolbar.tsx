import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const RouteHeaderToolbarContext = createContext<HTMLElement | null>(null);

export function RouteHeaderToolbar({ children }: { children: ReactNode }) {
  const target = useContext(RouteHeaderToolbarContext);
  return target ? createPortal(children, target) : null;
}
