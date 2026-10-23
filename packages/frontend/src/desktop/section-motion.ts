import { prefersReducedMotion } from '@/desktop/motion-setting';
import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigation, useNavigationType } from 'react-router';
import { desktopNavigation } from './navigation';
import { useHomeMotion } from './home-motion';
import { sectionDirection, sectionMotionTiming, sectionSurfaceFrames, visibleSectionBounds, type SectionBounds } from './section-motion-geometry';
import './section-motion.css';

const sectionIndex = (path: string) => desktopNavigation.findIndex((section) => path === section.path || path.startsWith(`${section.path}/`));
const routeSelector = '#desktop-content > .desktop-view';
const surfaceSelector = '.desktop-route-surface';
const easing = 'cubic-bezier(.22, 1, .36, 1)';
const historyIndex = () => (typeof window.history.state?.idx === 'number' ? (window.history.state.idx as number) : undefined);

export function useSectionMotion() {
  const location = useLocation();
  const navigation = useNavigation();
  const navigationType = useNavigationType();
  useHomeMotion(
    location.key,
    location.pathname === '/dashboard',
    navigationType === 'POP' ? sectionMotionTiming.historyEntry : sectionMotionTiming.cardEntry,
  );
  const previous = useRef({ path: location.pathname, key: location.key, index: undefined as number | undefined });
  const settled = useRef<SectionBounds | null>(null);
  const origin = useRef<SectionBounds | null>(null);
  const animations = useRef<Animation[]>([]);
  const capture = useRef<(() => void) | null>(null);
  const animatedSurface = useRef<HTMLElement | null>(null);
  const generation = useRef(0);

  useLayoutEffect(() => {
    previous.current.index = historyIndex();
    const read = () => {
      const view = document.querySelector<HTMLElement>(routeSelector);
      return view
        ? visibleSectionBounds((view.querySelector<HTMLElement>(surfaceSelector) ?? view).getBoundingClientRect(), window.innerHeight)
        : null;
    };
    capture.current = () => {
      origin.current = read();
    };
    const cache = () => {
      if (!animations.current.some((animation) => animation.playState === 'running')) settled.current = read();
    };
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin === window.location.origin && sectionIndex(url.pathname) !== sectionIndex(previous.current.path)) capture.current?.();
    };
    const observer = new ResizeObserver(cache);
    const main = document.querySelector('#desktop-content');
    if (main) observer.observe(main);
    document.addEventListener('click', click, true);
    window.addEventListener('scroll', cache, { passive: true });
    window.addEventListener('resize', cache);
    cache();
    return () => {
      generation.current++;
      for (const animation of animations.current) animation.cancel();
      animations.current = [];
      capture.current = null;
      observer.disconnect();
      document.removeEventListener('click', click, true);
      window.removeEventListener('scroll', cache);
      window.removeEventListener('resize', cache);
    };
  }, []);

  useLayoutEffect(() => {
    if (navigation.location && navigation.location.pathname !== previous.current.path && navigationType !== 'POP') capture.current?.();
  }, [navigation.location, navigationType]);

  useLayoutEffect(() => {
    if (previous.current.key === location.key) return;
    const before = previous.current;
    const nextIndex = historyIndex();
    previous.current = { path: location.pathname, key: location.key, index: nextIndex };
    const view = document.querySelector<HTMLElement>(routeSelector);
    if (!view) return;
    const surface = view.querySelector<HTMLElement>(surfaceSelector);
    const moving = animations.current.some((animation) => animation.playState === 'running' || animation.playState === 'paused');
    const from =
      moving && surface && surface === animatedSurface.current
        ? visibleSectionBounds(surface.getBoundingClientRect(), window.innerHeight)
        : (origin.current ?? settled.current);
    origin.current = null;
    generation.current++;
    const run = generation.current;
    for (const animation of animations.current) animation.cancel();
    animations.current = [];
    const to = visibleSectionBounds((surface ?? view).getBoundingClientRect(), window.innerHeight);
    settled.current = to;
    const fromSection = sectionIndex(before.path);
    const toSection = sectionIndex(location.pathname);
    if (fromSection === toSection || prefersReducedMotion() || typeof view.animate !== 'function') return;
    const direction = sectionDirection(fromSection, toSection, navigationType, before.index, nextIndex);
    const entry = navigationType === 'POP' ? sectionMotionTiming.historyEntry : sectionMotionTiming.cardEntry;
    view.dataset.sectionMotion = 'true';
    view.dataset.sectionPhase = 'card';
    animatedSurface.current = surface;
    const add = (animation: Animation) => {
      animations.current.push(animation);
      return animation;
    };
    if (surface) {
      // History restores document scroll; keep the glass anchored to its real page.
      if (navigationType !== 'POP') add(surface.animate(sectionSurfaceFrames(from ?? to, to), { duration: sectionMotionTiming.surface, easing }));
      add(surface.animate([{ opacity: 0.6 }, { opacity: 1 }], { duration: entry, easing }));
    }
    const content = surface ? view.querySelectorAll<HTMLElement>('.desktop-page-heading, .desktop-window-content') : [];
    for (const element of content) {
      add(
        element.animate(
          [
            { opacity: 0, transform: `translateX(${direction * 18}px)` },
            { opacity: 1, transform: 'none' },
          ],
          {
            delay: entry,
            duration: sectionMotionTiming.content,
            easing,
            fill: 'backwards',
          },
        ),
      );
    }
    void Promise.allSettled(animations.current.map((animation) => animation.finished)).then(() => {
      if (generation.current !== run || !view.isConnected) return;
      view.dataset.sectionPhase = 'ready';
      settled.current = visibleSectionBounds((surface ?? view).getBoundingClientRect(), window.innerHeight);
    });
  }, [location.key, location.pathname, navigationType]);
}
