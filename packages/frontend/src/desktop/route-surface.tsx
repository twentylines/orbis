import { useLayoutEffect, useRef, type PropsWithChildren, type ReactNode } from 'react';
import { revealPageFocus } from './window-viewport';
import './route-surface.css';

export function RouteSurface({ label, icon, children }: PropsWithChildren<{ label: string; icon: ReactNode }>) {
  const focusFrame = useRef<number | null>(null);
  useLayoutEffect(
    () => () => {
      if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    },
    [],
  );

  return (
    <section className="desktop-view desktop-view-app desktop-route-window desktop-route-page" data-window-navigation="page" aria-label={label}>
      <header className="desktop-page-heading">
        <span className="desktop-window-icon" aria-hidden="true">
          {icon}
        </span>
        <h1>{label}</h1>
      </header>
      <div
        className="desktop-window-content"
        onFocusCapture={(event) => {
          const target = event.target;
          if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
          focusFrame.current = requestAnimationFrame(() => {
            focusFrame.current = null;
            if (target.isConnected && document.activeElement === target) revealPageFocus(target);
          });
        }}
      >
        {children}
      </div>
    </section>
  );
}
