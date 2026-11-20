import { IconApps, IconArrowUp } from '@tabler/icons-react';
import { useLayoutEffect, useRef } from 'react';
import './dock-scroll.css';

export function dockNavigationFocusTarget() {
  return (
    document.querySelector<HTMLElement>('.desktop-dock[data-scroll-collapsed] .desktop-dock-reveal') ??
    document.querySelector<HTMLElement>('.desktop-dock-item[aria-current="page"]') ??
    document.querySelector<HTMLElement>('.desktop-dock-item')
  );
}

export function DockScrollReveal({
  collapsed,
  canScrollToTop,
  expand,
  scrollToTop,
}: {
  collapsed: boolean;
  canScrollToTop: boolean;
  expand: () => void;
  scrollToTop: () => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const topButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if ((!collapsed && active === button.current) || (!canScrollToTop && active === topButton.current))
      dockNavigationFocusTarget()?.focus({ preventScroll: true });
  }, [collapsed, canScrollToTop]);
  return (
    <>
      <span className="desktop-dock-top-space" aria-hidden="true" />
      <button
        ref={topButton}
        type="button"
        className="desktop-dock-scroll-top"
        aria-label="Scroll to top"
        aria-hidden={!canScrollToTop || undefined}
        tabIndex={canScrollToTop ? 0 : -1}
        onClick={scrollToTop}
      >
        <IconArrowUp size={23} stroke={1.8} aria-hidden="true" />
      </button>
      <button
        ref={button}
        type="button"
        className="desktop-dock-reveal"
        aria-label="Show navigation"
        aria-expanded={!collapsed}
        aria-hidden={!collapsed || undefined}
        tabIndex={collapsed ? 0 : -1}
        onFocus={expand}
        onClick={expand}
      >
        <svg className="desktop-dock-scroll-ring" viewBox="0 0 56 56" aria-hidden="true" focusable="false">
          <circle className="desktop-dock-scroll-track" cx="28" cy="28" r="23" />
          <circle className="desktop-dock-scroll-fill" cx="28" cy="28" r="23" pathLength="1" />
        </svg>
        <IconApps size={24} stroke={1.7} aria-hidden="true" />
      </button>
    </>
  );
}
