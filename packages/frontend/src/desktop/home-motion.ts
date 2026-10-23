import { useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from './motion-setting';

const tileSelector = [
  '.workspace-heading',
  '.workspace-widget:not(.workspace-widget-applications) > section',
  '.workspace-apps > .workspace-section-heading',
  '.workspace-app',
  '.workspace-apps .workspace-message',
  '.workspace-editor',
  '.workspace-all-hidden',
  '.cluster-home > *',
].join(', ');

export function useHomeMotion(key: string, active: boolean, direction: number) {
  const entrance = useRef({ key, direction });
  if (entrance.current.key !== key) entrance.current = { key, direction };
  const entryDirection = entrance.current.direction;
  useLayoutEffect(() => {
    if (!active || prefersReducedMotion()) return;
    const root = document.querySelector('#desktop-content');
    if (!root) return;
    const entered = new WeakSet<HTMLElement>();
    const animations: Animation[] = [];
    const animate = () => {
      if (document.querySelector('[data-initial-startup]:not([data-revealing])')) return;
      const view = root.querySelector<HTMLElement>('.desktop-view-home');
      if (!view) return;
      view.dataset.homeEntry = key;
      for (const tile of view.querySelectorAll<HTMLElement>(tileSelector)) {
        if (entered.has(tile)) continue;
        entered.add(tile);
        const bounds = tile.getBoundingClientRect();
        const delay = Math.min(96, Math.max(0, bounds.left / innerWidth) * 72 + Math.max(0, bounds.top / innerHeight) * 24);
        const distance = Math.min(40, innerWidth * 0.055) * entryDirection;
        const animation = tile.animate(
          [
            { opacity: 0, transform: `translateX(${distance}px)`, offset: 0 },
            { opacity: 1, offset: 0.3 },
            { opacity: 1, transform: 'none', offset: 1 },
          ],
          { duration: 420, delay, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'backwards' },
        );
        animation.id = 'orbis-home-tile';
        animations.push(animation);
      }
    };
    const observer = new MutationObserver(animate);
    observer.observe(root, { childList: true, subtree: true });
    animate();
    window.addEventListener('orbis-startup-reveal', animate);
    return () => {
      window.removeEventListener('orbis-startup-reveal', animate);
      observer.disconnect();
      for (const animation of animations) animation.cancel();
      const view = root.querySelector<HTMLElement>('.desktop-view-home');
      if (view?.dataset.homeEntry === key) delete view.dataset.homeEntry;
    };
  }, [active, entryDirection, key]);
}
