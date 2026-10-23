import { prefersReducedMotion } from '@/desktop/motion-setting';
import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigation } from 'react-router';
import { desktopNavigation } from './navigation';
import { sectionSurfaceFrames, visibleSectionBounds, type SectionBounds } from './section-motion-geometry';
import './section-motion.css';

const sectionIndex = (path: string) => desktopNavigation.findIndex((section) => path === section.path || path.startsWith(`${section.path}/`));
const surfaceSelector = '.desktop-route-surface';
const routeSelector = '#desktop-content > .desktop-view';

export function useSectionMotion() {
  const location = useLocation();
  const navigation = useNavigation();
  const previous = useRef(location.pathname);
  const origin = useRef<SectionBounds | null>(null);
  const animations = useRef<Animation[]>([]);
  const capture = useRef<(() => void) | null>(null);
  const animatedSurface = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const stop = () => {
      for (const animation of animations.current) animation.cancel();
      animations.current = [];
    };
    capture.current = () => {
      const surface = document.querySelector<HTMLElement>(surfaceSelector);
      const view = surface ?? document.querySelector<HTMLElement>(routeSelector);
      if (view) origin.current = visibleSectionBounds(view.getBoundingClientRect(), window.innerHeight);
    };
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin === window.location.origin && sectionIndex(url.pathname) !== sectionIndex(previous.current)) capture.current?.();
    };
    const back = () => capture.current?.();
    document.addEventListener('click', click, true);
    window.addEventListener('popstate', back);
    capture.current();
    return () => {
      stop();
      capture.current = null;
      document.removeEventListener('click', click, true);
      window.removeEventListener('popstate', back);
    };
  }, []);

  useLayoutEffect(() => {
    if (navigation.location && navigation.location.pathname !== previous.current) capture.current?.();
  }, [navigation.location]);

  useLayoutEffect(() => {
    if (previous.current === location.pathname) return;
    const fromIndex = sectionIndex(previous.current);
    const toIndex = sectionIndex(location.pathname);
    previous.current = location.pathname;
    const view = document.querySelector<HTMLElement>(routeSelector);
    if (!view || typeof view.animate !== 'function') return;
    const surface = view.querySelector<HTMLElement>(surfaceSelector);
    const moving = animations.current.some((animation) => animation.playState === 'running' || animation.playState === 'paused');
    const from =
      moving && surface === animatedSurface.current && surface
        ? visibleSectionBounds(surface.getBoundingClientRect(), window.innerHeight)
        : origin.current;
    for (const animation of animations.current) animation.cancel();
    animations.current = [];
    const to = visibleSectionBounds((surface ?? view).getBoundingClientRect(), window.innerHeight);
    origin.current = to;
    if (fromIndex === toIndex || prefersReducedMotion()) return;
    const options = { duration: 380, easing: 'cubic-bezier(.22, 1, .36, 1)' };
    animatedSurface.current = surface;
    if (surface) animations.current.push(surface.animate(sectionSurfaceFrames(from ?? to, to), options));
    const direction = toIndex >= fromIndex ? 1 : -1;
    const content = surface ? view.querySelectorAll<HTMLElement>('.desktop-page-heading, .desktop-window-content') : [view];
    for (const element of content) {
      animations.current.push(
        element.animate(
          [
            { opacity: 0, transform: `translateX(${direction * 28}px)` },
            { opacity: 1, transform: 'none' },
          ],
          options,
        ),
      );
    }
  }, [location.pathname]);
}
