import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export const SystemBarStatusContext = createContext<HTMLElement | null>(null);

export function SystemBarStatus({ children }: { children: ReactNode }) {
  const target = useContext(SystemBarStatusContext);
  return target ? createPortal(children, target) : null;
}
