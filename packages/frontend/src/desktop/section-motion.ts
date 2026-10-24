import { prefersReducedMotion } from '@/desktop/motion-setting';
import { useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router';
import { desktopNavigation } from './navigation';
import { useHomeMotion } from './home-motion';
import { sectionDirection, sectionMotionEasing, sectionMotionTiming } from './section-motion-geometry';
import './section-motion.css';

const sectionIndex = (path: string) => desktopNavigation.findIndex((section) => path === section.path || path.startsWith(`${section.path}/`));
const historyIndex = () => (typeof window.history.state?.idx === 'number' ? (window.history.state.idx as number) : undefined);

export function useSectionMotion(ready = true) {
  const location = useLocation();
  const action = useNavigationType();
  const previous = useRef({ path: location.pathname, key: location.key, index: historyIndex() });
  const motion = useRef<{ animation: Animation; view: HTMLElement } | null>(null);
  useHomeMotion(
    location.key,
    ready && location.pathname === '/dashboard',
    sectionDirection(sectionIndex(previous.current.path), sectionIndex(location.pathname), action, previous.current.index, historyIndex()),
  );

  useLayoutEffect(() => {
    if (!ready || previous.current.key === location.key) return;
    const before = previous.current;
    const next = { path: location.pathname, key: location.key, index: historyIndex() };
    previous.current = next;
    if (sectionIndex(before.path) === sectionIndex(next.path)) return;
    if (motion.current) {
      motion.current.animation.cancel();
      delete motion.current.view.dataset.sectionMotion;
      delete motion.current.view.dataset.sectionPhase;
      motion.current = null;
    }
    const view = document.querySelector<HTMLElement>('#desktop-content > .desktop-route-page');
    if (!view || prefersReducedMotion() || typeof view.animate !== 'function') return;
    const bounds = view.getBoundingClientRect();
    const distance = Math.min(24, Math.max(0, bounds.left), Math.max(0, window.innerWidth - bounds.right));
    const direction = sectionDirection(sectionIndex(before.path), sectionIndex(next.path), action, before.index, next.index);
    view.dataset.sectionMotion = 'true';
    view.dataset.sectionPhase = 'card';
    const animation = view.animate([{ transform: `translate3d(${direction * distance}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }], {
      duration: sectionMotionTiming.content,
      easing: sectionMotionEasing,
    });
    animation.id = 'orbis-section-travel';
    motion.current = { animation, view };
    const finish = () => {
      if (motion.current?.animation !== animation) return;
      delete view.dataset.sectionMotion;
      view.dataset.sectionPhase = 'ready';
      motion.current = null;
    };
    void animation.finished.then(finish, finish);
  }, [action, location.key, location.pathname, ready]);

  useLayoutEffect(
    () => () => {
      if (!motion.current) return;
      motion.current.animation.cancel();
      delete motion.current.view.dataset.sectionMotion;
      delete motion.current.view.dataset.sectionPhase;
      motion.current = null;
    },
    [],
  );
}
