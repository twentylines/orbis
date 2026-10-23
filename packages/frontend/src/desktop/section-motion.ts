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
  const path = navigation.location?.pathname ?? location.pathname;
  const key = navigation.location?.key ?? location.key;
  const previous = useRef({ path: location.pathname, key: location.key, index: undefined as number | undefined });
  const committed = useRef({ path: location.pathname, index: historyIndex() });
  const action = navigation.location ? (historyIndex() !== previous.current.index ? 'POP' : 'PUSH') : navigationType;
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
    if (navigation.location && navigation.location.pathname !== previous.current.path && navigationType !== 'POP' && !origin.current)
      origin.current = settled.current;
  }, [navigation.location, navigationType]);

  useLayoutEffect(() => {
    if (previous.current.key === key) return;
    const before = previous.current;
    const nextIndex = historyIndex();
    previous.current = { path, key, index: nextIndex };
    const view = document.querySelector<HTMLElement>(routeSelector);
    if (!view) return;
    const surface = view.querySelector<HTMLElement>(surfaceSelector);
    const moving = animations.current.some((animation) => animation.playState === 'running' || animation.playState === 'paused');
    const from =
      moving && surface && surface === animatedSurface.current
        ? visibleSectionBounds(view.getBoundingClientRect(), window.innerHeight)
        : (origin.current ?? settled.current);
    origin.current = null;
    generation.current++;
    const run = generation.current;
    for (const animation of animations.current) animation.cancel();
    animations.current = [];
    view.dataset.sectionPhase = 'ready';
    const bounds = view.getBoundingClientRect();
    const to = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
    settled.current = to;
    const fromSection = sectionIndex(before.path);
    const toSection = sectionIndex(path);
    if (fromSection === toSection || prefersReducedMotion() || typeof view.animate !== 'function') return;
    const direction = sectionDirection(fromSection, toSection, action, before.index, nextIndex);
    if (!surface) return;
    view.dataset.sectionMotion = 'true';
    view.dataset.sectionPhase = 'card';
    animatedSurface.current = surface;
    let resizing: Animation | null = null;
    let targetHeight = to.height;
    const content = view.querySelectorAll<HTMLElement>('.desktop-page-heading, .desktop-window-content');
    const observer = new ResizeObserver(() => {
      if (view.dataset.routePending || view.querySelector('.desktop-route-placeholder')) return;
      const style = getComputedStyle(view);
      const naturalHeight =
        [...content].reduce((height, element) => height + element.offsetHeight, 0) +
        Number.parseFloat(style.borderTopWidth) +
        Number.parseFloat(style.borderBottomWidth);
      if (Math.abs(naturalHeight - targetHeight) < 1 || view.dataset.sectionPhase !== 'card') return;
      const height = view.getBoundingClientRect().height;
      resizing?.cancel();
      targetHeight = naturalHeight;
      resizing = add(
        view.animate([{ height: `${height}px` }, { height: `${naturalHeight}px` }], {
          duration: sectionMotionTiming.content,
          easing,
        }),
      );
    });
    const finish = () => {
      if (
        generation.current !== run ||
        !view.isConnected ||
        animations.current.some((item) => item.playState === 'running' || item.playState === 'paused')
      )
        return;
      observer.disconnect();
      view.dataset.sectionPhase = 'ready';
      settled.current = visibleSectionBounds(view.getBoundingClientRect(), window.innerHeight);
    };
    const add = (animation: Animation) => {
      animations.current.push(animation);
      void animation.finished.then(finish, finish);
      return animation;
    };
    if (action !== 'POP') resizing = add(view.animate(sectionSurfaceFrames(from ?? to, to), { duration: sectionMotionTiming.surface, easing }));
    for (const element of content) {
      add(
        element.animate([{ transform: `translateX(${direction * 18}px)` }, { transform: 'none' }], { duration: sectionMotionTiming.content, easing }),
      );
      if (action !== 'POP') observer.observe(element);
    }
    return () => observer.disconnect();
  }, [key, path, action]);

  useLayoutEffect(() => {
    if (navigation.location || previous.current.key !== location.key) return;
    previous.current.index = historyIndex();
    committed.current = { path: location.pathname, index: historyIndex() };
  }, [location.key, location.pathname, navigation.location]);
}
