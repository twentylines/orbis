import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const RouteHeaderStatusContext = createContext<HTMLElement | null>(null);

export function RouteHeaderStatus({ children }: { children: ReactNode }) {
  const target = useContext(RouteHeaderStatusContext);
  return target ? createPortal(children, target) : null;
}
