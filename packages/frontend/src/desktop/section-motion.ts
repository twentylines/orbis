import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigation } from 'react-router';
import { desktopNavigation } from './navigation';
import './section-motion.css';

const sectionIndex = (path: string) => desktopNavigation.findIndex((section) => path === section.path || path.startsWith(`${section.path}/`));

export function useSectionMotion() {
  const location = useLocation();
  const navigation = useNavigation();
  const previous = useRef(location.pathname);
  useLayoutEffect(() => {
    const next = navigation.location?.pathname ?? location.pathname;
    const from = sectionIndex(previous.current);
    const to = sectionIndex(next);
    document.documentElement.style.setProperty('--orbis-slide-direction', to >= from ? '1' : '-1');
    if (navigation.location) return;
    if (
      previous.current !== location.pathname &&
      from !== to &&
      !document.startViewTransition &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      document.querySelector('.desktop-view')?.animate(
        [
          { opacity: 0, transform: `translateX(${to >= from ? 48 : -48}px)` },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 380, easing: 'cubic-bezier(.22, 1, .36, 1)' },
      );
    }
    previous.current = location.pathname;
  }, [location.pathname, navigation.location]);
}
