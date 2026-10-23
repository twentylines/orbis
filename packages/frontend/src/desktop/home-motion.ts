import { useLayoutEffect } from 'react';
import { prefersReducedMotion } from './motion-setting';
import { sectionMotionTiming } from './section-motion-geometry';

const backgroundSelector = '.workspace-heading, .workspace-widget > section, .workspace-editor, .workspace-all-hidden, .cluster-home > *';
const contentSelector =
  '.workspace-heading > div, .workspace-widget > section > *, .workspace-editor > *, .workspace-all-hidden > *, .cluster-home > * > *';
const easing = 'cubic-bezier(.22, 1, .36, 1)';

export function useHomeMotion(key: string, active: boolean, entry: number) {
  useLayoutEffect(() => {
    if (!active || prefersReducedMotion()) return;
    const view = document.querySelector<HTMLElement>('#desktop-content > .desktop-view-home');
    if (!view) return;
    view.dataset.homeEntry = key;
    const backgrounds = new WeakMap<HTMLElement, number>();
    const contents = new WeakMap<HTMLElement, Animation>();
    const tiles = new WeakSet<HTMLElement>();
    const animations: Animation[] = [];
    const animate = () => {
      const now = performance.now();
      for (const element of view.querySelectorAll<HTMLElement>(backgroundSelector)) {
        if (backgrounds.has(element)) continue;
        backgrounds.set(element, now);
        animations.push(
          element.animate(
            [
              { opacity: 0.6, transform: 'translateY(10px)' },
              { opacity: 1, transform: 'none' },
            ],
            { duration: entry, easing },
          ),
        );
      }
      for (const element of view.querySelectorAll<HTMLElement>(contentSelector)) {
        if (contents.has(element)) continue;
        const background = element.parentElement?.closest<HTMLElement>(backgroundSelector);
        const delay = Math.max(0, entry - (now - (background ? (backgrounds.get(background) ?? now) : now)));
        const animation = element.animate(
          [
            { opacity: 0, transform: 'translateY(12px)' },
            { opacity: 1, transform: 'none' },
          ],
          { duration: sectionMotionTiming.content, delay, easing, fill: 'backwards' },
        );
        contents.set(element, animation);
        animations.push(animation);
      }
      for (const tile of view.querySelectorAll<HTMLElement>('.workspace-app')) {
        if (tiles.has(tile)) continue;
        tiles.add(tile);
        const group = tile.parentElement?.closest<HTMLElement>(contentSelector);
        const entrance = group ? contents.get(group) : null;
        if (entrance && entrance.playState !== 'finished' && entrance.playState !== 'idle') continue;
        animations.push(
          tile.animate(
            [
              { opacity: 0, transform: 'translateY(10px)' },
              { opacity: 1, transform: 'none' },
            ],
            { duration: sectionMotionTiming.content, easing },
          ),
        );
      }
    };
    const observer = new MutationObserver(animate);
    observer.observe(view, { childList: true, subtree: true });
    animate();
    return () => {
      observer.disconnect();
      for (const animation of animations) animation.cancel();
      if (view.dataset.homeEntry === key) delete view.dataset.homeEntry;
    };
  }, [active, entry, key]);
}
