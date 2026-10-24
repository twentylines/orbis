import { useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from './motion-setting';
import { dockMotionDuration, sectionMotionEasing } from './section-motion-geometry';

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
const openingSelector =
  '.workspace-heading, .workspace-apps, .workspace-widget:not(.workspace-widget-applications) > section, .workspace-all-hidden, .cluster-home > *';

export function useHomeMotion(key: string, active: boolean, direction: number) {
  const entrance = useRef({ key, direction });
  if (entrance.current.key !== key) entrance.current = { key, direction };
  const entryDirection = entrance.current.direction;
  useLayoutEffect(() => {
    if (!active || prefersReducedMotion()) return;
    const root = document.querySelector('#desktop-content');
    if (!root) return;
    const entered = new WeakSet<HTMLElement>();
    const animations = new Set<Animation>();
    const opening = Boolean(document.querySelector('[data-initial-startup]'));
    let openingStart: number | null = null;
    const animate = () => {
      if (document.querySelector('[data-initial-startup]:not([data-revealing])')) return;
      const view = root.querySelector<HTMLElement>('.desktop-view-home');
      if (!view) return;
      view.dataset.homeEntry = key;
      const tiles = [...view.querySelectorAll<HTMLElement>(openingSelector)].filter((tile) => !entered.has(tile));
      const distance = opening ? Math.min(72, innerWidth * 0.08) : Math.min(40, innerWidth * 0.055) * entryDirection;
      const now = document.timeline.currentTime;
      if (opening && openingStart === null && typeof now === 'number') openingStart = now;
      const start = opening ? openingStart : now;
      const viewBounds = view.getBoundingClientRect();
      const positions = tiles.map((tile) => {
        const bounds = tile.getBoundingClientRect();
        return {
          tile,
          delay: opening ? Math.min(120, Math.max(0, (bounds.left - viewBounds.left) / Math.max(1, viewBounds.width)) * 120) : 0,
        };
      });
      for (const { tile, delay } of positions) {
        entered.add(tile);
        const animation = tile.animate(
          opening
            ? [{ transform: `translate3d(${distance}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }]
            : [{ transform: `translateX(${distance}px)` }, { transform: 'none' }],
          {
            duration: opening ? 760 : dockMotionDuration,
            delay,
            easing: opening ? 'cubic-bezier(.2, .7, .2, 1)' : sectionMotionEasing,
            fill: 'backwards',
          },
        );
        animation.id = 'orbis-home-tile';
        if (typeof start === 'number') animation.startTime = start;
        animations.add(animation);
        void animation.finished.then(
          () => {
            animations.delete(animation);
            animation.cancel();
          },
          () => animations.delete(animation),
        );
      }
    };
    const observer = new MutationObserver((records) => {
      if (
        !records.some((record) =>
          [...record.addedNodes].some((node) => node instanceof Element && (node.matches(tileSelector) || node.querySelector(tileSelector))),
        )
      )
        return;
      animate();
    });
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
