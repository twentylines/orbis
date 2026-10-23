import { prefersReducedMotion } from '@/desktop/motion-setting';
import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigation, useNavigationType } from 'react-router';
import { desktopNavigation } from './navigation';
import { useHomeMotion } from './home-motion';
import {
  sectionDirection,
  sectionMotionEasing,
  sectionMotionTiming,
  sectionSurfaceFrames,
  visibleSectionBounds,
  type SectionBounds,
} from './section-motion-geometry';
import './section-motion.css';

const sectionIndex = (path: string) => desktopNavigation.findIndex((section) => path === section.path || path.startsWith(`${section.path}/`));
const routeSelector = '#desktop-content > .desktop-view';
const surfaceSelector = '.desktop-route-surface';
const easing = sectionMotionEasing;
const historyIndex = () => (typeof window.history.state?.idx === 'number' ? (window.history.state.idx as number) : undefined);

export function useSectionMotion() {
  const location = useLocation();
  const navigation = useNavigation();
  const navigationType = useNavigationType();
  const path = location.pathname;
  const key = location.key;
  const previous = useRef({ path: location.pathname, key: location.key, index: undefined as number | undefined });
  const committed = useRef({ path: location.pathname, index: historyIndex() });
  const action = navigationType;
  useHomeMotion(
    location.key,
    location.pathname === '/dashboard',
    sectionDirection(sectionIndex(committed.current.path), sectionIndex(location.pathname), navigationType, committed.current.index, historyIndex()),
  );
  const settled = useRef<SectionBounds | null>(null);
  const origin = useRef<SectionBounds | null>(null);
  const animations = useRef<Animation[]>([]);
  const capture = useRef<(() => void) | null>(null);
  const animatedSurface = useRef<HTMLElement | null>(null);
  const generation = useRef(0);
  const cleanupMotion = useRef<(() => void) | null>(null);

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
    let cacheFrame = 0;
    const scheduleCache = () => {
      if (!cacheFrame)
        cacheFrame = requestAnimationFrame(() => {
          cacheFrame = 0;
          cache();
        });
    };
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin === window.location.origin && sectionIndex(url.pathname) !== sectionIndex(previous.current.path)) capture.current?.();
    };
    const observer = new ResizeObserver(scheduleCache);
    const main = document.querySelector('#desktop-content');
    if (main) observer.observe(main);
    document.addEventListener('click', click, true);
    window.addEventListener('scroll', scheduleCache, { passive: true });
    window.addEventListener('resize', scheduleCache);
    cache();
    return () => {
      generation.current++;
      cleanupMotion.current?.();
      for (const animation of animations.current) animation.cancel();
      animations.current = [];
      capture.current = null;
      cancelAnimationFrame(cacheFrame);
      observer.disconnect();
      document.removeEventListener('click', click, true);
      window.removeEventListener('scroll', scheduleCache);
      window.removeEventListener('resize', scheduleCache);
    };
  }, []);

  useLayoutEffect(() => {
    if (navigation.location && navigation.location.pathname !== previous.current.path && navigationType !== 'POP' && !origin.current)
      origin.current = settled.current;
  }, [navigation.location, navigationType]);

  useLayoutEffect(() => {
    if (previous.current.key === key) return;
    const before = previous.current;
    const nextIndex = historyIndex();
    previous.current = { path, key, index: nextIndex };
    const fromSection = sectionIndex(before.path);
    const toSection = sectionIndex(path);
    if (fromSection === toSection) return;
    const view = document.querySelector<HTMLElement>(routeSelector);
    if (!view) return;
    const surface = view.querySelector<HTMLElement>(surfaceSelector);
    const moving = animations.current.some((animation) => animation.playState === 'running' || animation.playState === 'paused');
    const from =
      moving && surface && surface === animatedSurface.current
        ? visibleSectionBounds(view.getBoundingClientRect(), window.innerHeight)
        : (origin.current ?? settled.current);
    origin.current = null;
    cleanupMotion.current?.();
    generation.current++;
    const run = generation.current;
    for (const animation of animations.current) animation.cancel();
    animations.current = [];
    view.dataset.sectionPhase = 'ready';
    delete view.dataset.sectionMotion;
    const bounds = view.getBoundingClientRect();
    const to = visibleSectionBounds(bounds, window.innerHeight);
    settled.current = to;
    if (prefersReducedMotion() || typeof view.animate !== 'function') return;
    const direction = sectionDirection(fromSection, toSection, action, before.index, nextIndex);
    if (!surface) return;
    view.dataset.sectionMotion = 'true';
    view.dataset.sectionPhase = 'card';
    animatedSurface.current = surface;
    let resizing: Animation | null = null;
    let targetHeight = to.height;
    const startedAt = document.timeline.currentTime;
    const content = view.querySelectorAll<HTMLElement>('.desktop-page-heading, .desktop-window-content');
    let resizeFrame = 0;
    const resize = () => {
      if (view.dataset.routePending || view.querySelector('.desktop-route-placeholder')) return;
      const style = getComputedStyle(view);
      const naturalHeight = Math.min(
        [...content].reduce((height, element) => height + element.offsetHeight, 0) +
          Number.parseFloat(style.borderTopWidth) +
          Number.parseFloat(style.borderBottomWidth),
        Math.max(1, window.innerHeight - to.top),
      );
      if (Math.abs(naturalHeight - targetHeight) < 1 || view.dataset.sectionPhase !== 'card') return;
      const height = view.getBoundingClientRect().height;
      resizing?.cancel();
      targetHeight = naturalHeight;
      const elapsed =
        typeof startedAt === 'number' && typeof document.timeline.currentTime === 'number' ? document.timeline.currentTime - startedAt : 0;
      resizing = add(
        view.animate([{ height: `${height}px` }, { height: `${naturalHeight}px` }], {
          duration: Math.max(180, sectionMotionTiming.surface - elapsed),
          easing,
        }),
      );
    };
    const observer = new ResizeObserver(() => {
      if (!resizeFrame)
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = 0;
          resize();
        });
    });
    const finish = () => {
      if (
        generation.current !== run ||
        !view.isConnected ||
        animations.current.some((item) => item.playState === 'running' || item.playState === 'paused')
      )
        return;
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      view.dataset.sectionPhase = 'ready';
      delete view.dataset.sectionMotion;
      settled.current = visibleSectionBounds(view.getBoundingClientRect(), window.innerHeight);
    };
    const add = (animation: Animation) => {
      animations.current.push(animation);
      void animation.finished.then(finish, finish);
      return animation;
    };
    resizing = add(view.animate(sectionSurfaceFrames(from ?? to, to), { duration: sectionMotionTiming.surface, easing }));
    if (typeof startedAt === 'number') resizing.startTime = startedAt;
    for (const element of content) {
      const animation = add(
        element.animate([{ transform: `translateX(${direction * 18}px)` }, { transform: 'none' }], { duration: sectionMotionTiming.content, easing }),
      );
      if (typeof startedAt === 'number') animation.startTime = startedAt;
      observer.observe(element);
    }
    cleanupMotion.current = () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
    };
  }, [key, path, action]);

  useLayoutEffect(() => {
    if (navigation.location || previous.current.key !== location.key) return;
    previous.current.index = historyIndex();
    committed.current = { path: location.pathname, index: historyIndex() };
  }, [location.key, location.pathname, navigation.location]);
}
