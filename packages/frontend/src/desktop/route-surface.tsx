import { useLayoutEffect, useMemo, useRef, type CSSProperties, type PropsWithChildren, type ReactNode } from 'react';
import { revealPageFocus } from './window-viewport';
import { prefersReducedMotion } from './motion-setting';
import { sectionMotionTiming } from './section-motion-geometry';
import { useDesktopPreferences } from './preferences';
import './route-surface.css';

const sizes = new Map<string, number>();

export function RouteSurface({
  label,
  icon,
  section,
  pending,
  children,
}: PropsWithChildren<{ label: string; icon: ReactNode; section: string; pending: boolean }>) {
  const surface = useRef<HTMLElement>(null);
  const focusFrame = useRef<number | null>(null);
  const waiting = useRef<{ key: string; height: number } | null>(null);
  const measured = useRef<{ key: string; height: number } | null>(null);
  const reveal = useRef<{ animation: Animation; target: number } | null>(null);
  const { preferences } = useDesktopPreferences();
  const sizeKey = `${section}:${window.innerWidth}:${preferences.appearance.textScale}`;
  const reserve = useMemo(() => sizes.get(sizeKey) ?? Math.max(280, window.innerHeight - 210), [sizeKey]);
  useLayoutEffect(() => {
    const view = surface.current;
    if (!view) return;
    if (pending) {
      waiting.current = { key: sizeKey, height: reserve };
      return;
    }
    const animateTo = (from: number, height: number, duration = sectionMotionTiming.surface as number) => {
      reveal.current?.animation.cancel();
      view.dataset.cardRevealing = 'true';
      const animation = view.animate([{ height: `${from}px` }, { height: `${height}px` }], {
        duration,
        easing: 'cubic-bezier(.22, 1, .36, 1)',
      });
      animation.id = 'orbis-card-reveal';
      reveal.current = { animation, target: height };
      void animation.finished.then(
        () => {
          if (reveal.current?.animation !== animation) return;
          reveal.current = null;
          delete view.dataset.cardRevealing;
        },
        () => undefined,
      );
    };
    const measure = () => {
      if (view.querySelector('.desktop-route-placeholder')) {
        waiting.current = { key: sizeKey, height: view.getBoundingClientRect().height };
        return;
      }
      const content = view.querySelector<HTMLElement>('.desktop-window-content');
      const heading = view.querySelector<HTMLElement>('.desktop-page-heading');
      if (!content || !heading) return;
      const height = Math.ceil(content.offsetHeight + heading.offsetHeight + 2);
      sizes.set(sizeKey, height);
      if (sizes.size > 64) sizes.delete(sizes.keys().next().value as string);
      const previous = waiting.current ?? measured.current;
      waiting.current = null;
      measured.current = { key: sizeKey, height };
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
      animateTo(previous.height, height);
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
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      reveal.current?.animation.cancel();
      reveal.current = null;
      delete view.dataset.cardRevealing;
    };
  }, [pending, reserve, sizeKey]);
  useLayoutEffect(
    () => () => {
      if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    },
    [],
  );

  return (
    <section
      ref={surface}
      className="desktop-view desktop-view-app desktop-route-window desktop-route-page"
      data-window-navigation="page"
      data-route-pending={pending || undefined}
      style={{ '--orbis-route-reserve': `${reserve}px` } as CSSProperties}
      aria-label={label}
    >
      <div className="desktop-route-surface" aria-hidden="true" />
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
