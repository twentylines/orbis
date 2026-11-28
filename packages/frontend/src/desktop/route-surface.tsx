import { PaneScrollProgress } from '@/components/pane-scroll-progress';
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PropsWithChildren, type ReactNode } from 'react';
import { revealPageFocus, useDesktopWindows } from './window-viewport';
import { prefersReducedMotion } from './motion-setting';
import { sectionMotionEasing, sectionMotionTiming, visibleSectionBounds } from './section-motion-geometry';
import { useDesktopPreferences } from './preferences';
import './route-surface.css';
import { RouteHeaderToolbarContext } from './route-header-toolbar';
import { RouteHeaderStatusContext } from './route-header-status';

const sizes = new Map<string, number>();

export function RouteSurface({ label, icon, section, children }: PropsWithChildren<{ label: string; icon: ReactNode; section: string }>) {
  const surface = useRef<HTMLElement>(null);
  const heading = useRef<HTMLElement>(null);
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<HTMLDivElement | null>(null);
  const focusFrame = useRef<number | null>(null);
  const deferred = useRef(false);
  const measured = useRef<{ key: string; height: number } | null>(null);
  const reveal = useRef<{ animation: Animation; target: number } | null>(null);
  const { preferences } = useDesktopPreferences();
  const desktop = useDesktopWindows();
  const routeSection = section.split('/')[1];
  const fixedViewport = desktop && /^\/(?:apps|app-store|settings|tasks|monitor|updates)(?:\/|$)/.test(section);
  const sizeKey = `${section}:${window.innerWidth}:${preferences.appearance.textScale}`;
  const reserve = useMemo(() => sizes.get(sizeKey) ?? Math.max(280, window.innerHeight - 210), [sizeKey]);
  useLayoutEffect(() => {
    const view = surface.current;
    const title = heading.current;
    if (!fixedViewport || !view || !title) return;
    const measure = (height = title.offsetHeight) => view.style.setProperty('--desktop-route-header-height', `${height}px`);
    measure();
    const observer = new ResizeObserver(([entry]) => measure(entry?.borderBoxSize?.[0]?.blockSize));
    observer.observe(title, { box: 'border-box' });
    return () => {
      observer.disconnect();
      view.style.removeProperty('--desktop-route-header-height');
    };
  }, [fixedViewport]);
  useLayoutEffect(() => {
    const view = surface.current;
    // These pages size their scrolling panes from the viewport, not their contents.
    if (!view || fixedViewport) return;
    const animateTo = (from: number, height: number, duration = sectionMotionTiming.surface as number) => {
      reveal.current?.animation.cancel();
      view.dataset.cardRevealing = 'true';
      const animation = view.animate([{ height: `${from}px` }, { height: `${height}px` }], {
        duration,
        easing: sectionMotionEasing,
      });
      animation.id = 'orbis-card-reveal';
      reveal.current = { animation, target: height };
      void animation.finished.then(
        () => {
          if (reveal.current?.animation !== animation) return;
          reveal.current = null;
          delete view.dataset.cardRevealing;
          const active = document.activeElement;
          if (active instanceof HTMLElement && view.contains(active)) revealPageFocus(active);
        },
        () => undefined,
      );
    };
    const measure = () => {
      if (view.querySelector('.desktop-route-placeholder')) {
        deferred.current = true;
        return;
      }
      const content = view.querySelector<HTMLElement>('.desktop-window-content');
      const title = heading.current;
      if (!content || !title) return;
      const height = Math.ceil(content.offsetHeight + title.offsetHeight + 2);
      sizes.set(sizeKey, height);
      if (sizes.size > 64) sizes.delete(sizes.keys().next().value as string);
      const previous = measured.current;
      measured.current = { key: sizeKey, height };
      if (deferred.current) {
        deferred.current = false;
        return;
      }
      if (view.dataset.sectionPhase === 'card') return;
      const underway = reveal.current;
      if (underway && ['running', 'paused'].includes(underway.animation.playState)) {
        if (Math.abs(underway.target - height) > 1) {
          const elapsed = typeof underway.animation.currentTime === 'number' ? underway.animation.currentTime : 0;
          const duration = Number(underway.animation.effect?.getTiming().duration) || sectionMotionTiming.surface;
          animateTo(view.getBoundingClientRect().height, height, Math.max(100, duration - elapsed));
        }
        return;
      }
      if (!previous || previous.key !== sizeKey || Math.abs(previous.height - height) < 1 || prefersReducedMotion()) return;
      const moving = view
        .getAnimations()
        .some(
          (animation) =>
            ['running', 'paused'].includes(animation.playState) &&
            animation.effect instanceof KeyframeEffect &&
            animation.effect.getKeyframes().some((frame) => frame.height),
        );
      if (moving) return;
      const visible = (height: number) =>
        visibleSectionBounds({ left: 0, top: view.getBoundingClientRect().top, width: 0, height }, innerHeight).height;
      const from = visible(previous.height);
      const to = visible(height);
      // A zero-distance reveal would still clip a tall page to the viewport height.
      if (Math.abs(from - to) >= 1) animateTo(from, to);
    };
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      if (!resizeFrame)
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = 0;
          measure();
        });
    });
    for (const child of view.children) if (child.classList.contains('desktop-window-content') || child.tagName === 'HEADER') observer.observe(child);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      measure();
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      reveal.current?.animation.cancel();
      reveal.current = null;
      delete view.dataset.cardRevealing;
    };
  }, [fixedViewport, sizeKey]);
  useLayoutEffect(
    () => () => {
      if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    },
    [],
  );

  return (
    <RouteHeaderStatusContext.Provider value={status}>
      <RouteHeaderToolbarContext.Provider value={toolbar}>
        <section
          ref={surface}
          className="desktop-view desktop-view-app desktop-route-window desktop-route-page"
          data-window-navigation="page"
          data-route-section={routeSection}
          data-header-internal-scroll={fixedViewport || undefined}
          style={{ '--orbis-route-reserve': `${reserve}px` } as CSSProperties}
          aria-label={label}
        >
          <div className="desktop-route-surface" aria-hidden="true" />
          <header ref={heading} className="desktop-page-heading">
            <span className="desktop-window-icon" aria-hidden="true">
              {icon}
            </span>
            <div className="desktop-page-label">
              <h1>{label}</h1>
              <div className="desktop-page-status" ref={setStatus} />
            </div>
            <div className="desktop-page-toolbar" ref={setToolbar} />
          </header>
          <div
            className="desktop-window-content"
            onFocusCapture={(event) => {
              const target = event.target;
              if (!target.matches(':focus-visible')) return;
              if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
              focusFrame.current = requestAnimationFrame(() => {
                focusFrame.current = null;
                if (target.isConnected && document.activeElement === target) revealPageFocus(target);
              });
            }}
          >
            {desktop && (routeSection === 'apps' || routeSection === 'updates') ? <PaneScrollProgress label={`${label} scroll position`} /> : null}
            {children}
          </div>
        </section>
      </RouteHeaderToolbarContext.Provider>
    </RouteHeaderStatusContext.Provider>
  );
}
